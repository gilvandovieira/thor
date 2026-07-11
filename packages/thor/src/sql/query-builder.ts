/**
 * The fluent, pure query builder (spec §4.1, §6).
 *
 * Builders never touch the database — they assemble immutable IR. Only the
 * terminal methods (`all`/`one`/`maybeOne`/`run`) return an `Effect` that
 * requires the `Database` service. This module owns the `SELECT` builder and the
 * `db` entry point; the insert/update/delete builders live in
 * {@link module:sql/mutation-builder} and the shared typing, selection helpers,
 * and prepared handle in {@link module:sql/query-builder-support}.
 *
 * @module sql/query-builder
 */
import { Effect, Option, Schema } from "effect"
import type { Column } from "../schema/column.js"
import { type AnyTable, TableMeta, tableMeta } from "../schema/table.js"
import {
  type CommonTableExpression,
  type ExprNode,
  type JoinType,
  type OrderByTerm,
  type QuerySource,
  type SelectionField,
  type SelectIR,
  queryCapabilityBits,
  nextId
} from "../ir/query-ir.js"
import { capabilityBit, type Capability, bitsToCapabilities, noCapabilities } from "../capabilities/capability.js"
import type { Dialect } from "../dialect.js"
import { PostgresDialect } from "../postgres/dialect.js"
import { GuardError, type QueryError, type NotFoundError, type TooManyRowsError } from "../errors/index.js"
import { Database } from "../execution/database.js"
import { atMostOne, exactlyOne, executeCompiledRows, executeRows } from "../execution/run.js"
import type { CompiledStatement } from "../execution/driver.js"
import { compilableEffect } from "../execution/compiled-query.js"
import { withMode, withQueryCache } from "../execution/plan.js"
import { withObservability } from "../observability/index.js"
import { type Expr, type ParamsOf, columnRef, isColumn } from "./expressions.js"
import { type ExpressionInput } from "./advanced-expressions.js"
import { internIdentifier } from "../ir/identifiers.js"
import { transaction } from "../execution/transaction.js"
import {
  argsFrom,
  inspectIr,
  PreparedQuery,
  selectionFrom,
  type ExactTerminalArguments,
  type MergeParams,
  type NamedParams,
  type SelectFields,
  type SelectResult,
  type TerminalArguments,
  type TerminalCallResult
} from "./query-builder-support.js"
import { DeleteBuilder, InsertBuilder, type ReturningQuery, UpdateBuilder } from "./mutation-builder.js"

// --- join typing -------------------------------------------------------------

type SourceName<T> = T extends { readonly [TableMeta]: { readonly name: infer Name extends string } } ? Name : string
type FieldSource<T> = T extends Column<infer C>
  ? C extends { readonly table: infer Name extends string }
    ? Name
    : never
  : never
type LeftJoined<A, F extends SelectFields, Name extends string> = {
  [K in keyof A]: K extends keyof F
    ? [FieldSource<F[K]>] extends [never]
      ? A[K]
      : FieldSource<F[K]> extends Name
        ? A[K] | null
        : A[K]
    : A[K]
}
type RightJoined<A, F extends SelectFields, Name extends string> = {
  [K in keyof A]: K extends keyof F
    ? [FieldSource<F[K]>] extends [never]
      ? A[K] | null
      : FieldSource<F[K]> extends Name
        ? A[K]
        : A[K] | null
    : A[K]
}
type FullJoined<A> = { [K in keyof A]: A[K] | null }

/**
 * Detects syntax capabilities introduced directly by an expression.
 *
 * @param node - Expression to inspect.
 * @returns Capability bits required by the expression syntax.
 */
const expressionSyntaxCapabilities = (node: ExprNode): bigint => {
  switch (node._tag) {
    case "WindowFunction":
      return capabilityBit("select.windowFunctions") | expressionSyntaxCapabilities(node.function)
    case "Comparison":
      return expressionSyntaxCapabilities(node.left) | expressionSyntaxCapabilities(node.right)
    case "InList":
      return node.values.reduce(
        (bits, value) => bits | expressionSyntaxCapabilities(value),
        expressionSyntaxCapabilities(node.expr)
      )
    case "Logical":
      return node.operands.reduce((bits, operand) => bits | expressionSyntaxCapabilities(operand), noCapabilities)
    case "Not":
    case "IsNull":
      return expressionSyntaxCapabilities(node.expr)
    case "InSubquery":
      return expressionSyntaxCapabilities(node.expr)
    case "FunctionCall":
      return node.args.reduce((bits, arg) => bits | expressionSyntaxCapabilities(arg), node.capabilities)
    case "ColumnRef":
    case "Param":
    case "Literal":
    case "RawExpr":
    case "ScalarSubquery":
    case "Exists":
    case "ExcludedRef":
      return noCapabilities
  }
}

/**
 * @param fields - Selection fields to inspect.
 * @returns Union of expression syntax capabilities.
 */
const selectionSyntaxCapabilities = (fields: ReadonlyArray<SelectionField>): bigint =>
  fields.reduce((bits, field) => bits | expressionSyntaxCapabilities(field.expr), noCapabilities)

/** @param source - Relation source. @returns Its visible SQL name or alias. */
const sourceVisibleName = (source: QuerySource): string => {
  if ("_tag" in source) {
    if (source._tag === "SubquerySource" || source._tag === "TableFunctionSource") return source.alias
    return source.alias ?? source.name
  }
  return source.alias ?? source.name
}

/** @param field - Selected field. @returns A copy accepting SQL null. */
const nullableField = (field: SelectionField): SelectionField => ({ ...field, codec: Schema.NullOr(field.codec) })

/**
 * Rejects pagination values that would compile to invalid SQL (`LIMIT NaN`,
 * `LIMIT Infinity`, negative pagination, or fractional counts) before any IR is
 * built (spec §6, P0.6).
 *
 * @param clause - `"limit"` or `"offset"`, used in the error message.
 * @param n - Candidate pagination value.
 * @returns Nothing; throws when the value is invalid.
 * @throws {GuardError} When `n` is not a finite, non-negative safe integer.
 */
const assertPaginationValue = (clause: "limit" | "offset", n: number): void => {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new GuardError({
      guard: `${clause}-shape`,
      message: `${clause} must be a finite, non-negative safe integer, received ${n}`
    })
  }
}

/**
 * @param fields - Current decoder selection.
 * @param type - Join kind being added.
 * @param existingSources - Visible names on the existing side.
 * @param joinedSource - Visible name of the new side.
 * @returns Selection codecs adjusted for outer-join null extension.
 */
const fieldsForJoin = (
  fields: ReadonlyArray<SelectionField>,
  type: JoinType,
  existingSources: ReadonlySet<string>,
  joinedSource: string
): SelectionField[] =>
  fields.map((field) => {
    // Non-column expressions can resolve over the null-extended side, so mirror the
    // RightJoined/FullJoined row types (which mark them nullable) in the decoder.
    if (field.expr._tag !== "ColumnRef") return type === "full" || type === "right" ? nullableField(field) : field
    const nullable =
      type === "full" ||
      (type === "left" && field.expr.table === joinedSource) ||
      (type === "right" && existingSources.has(field.expr.table))
    return nullable ? nullableField(field) : field
  })

/**
 * Query-local named relation backed by a select query.
 *
 * @stable
 */
export class QueryReference<A> {
  /**
   * @param source - Relation source embedded in `FROM` or `JOIN`.
   * @param fields - Selected fields exposed by name.
   * @param cte - Optional CTE definition attached when this reference enters a query.
   */
  constructor(
    readonly source: QuerySource,
    private readonly fields: ReadonlyArray<SelectionField>,
    readonly cte?: CommonTableExpression
  ) {}

  /**
   * @typeParam K - Selected output key.
   * @param name - Selected output alias to reference.
   * @returns A typed column-like expression bound to this relation.
   */
  field<K extends Extract<keyof A, string>>(name: K): Expr<A[K]> {
    const field = this.fields.find((candidate) => candidate.alias === name)
    const table =
      "_tag" in this.source && this.source._tag === "SubquerySource"
        ? this.source.alias
        : (this.source.alias ?? this.source.name)
    const dataType = field?.expr._tag === "ColumnRef" ? field.expr.dataType : "text"
    return {
      node: { _tag: "ColumnRef", table, column: name, dataType },
      ...(field ? { codec: field.codec as Schema.Schema<A[K], any> } : {})
    }
  }
}

type QuerySourceInput = AnyTable | QueryReference<any>

/**
 * Resolves a table or named query reference into select source metadata.
 *
 * @param input - Table, subquery, or CTE reference.
 * @returns Source IR, physical table names, and attached CTE definitions.
 */
const resolveSource = (
  input: QuerySourceInput
): {
  readonly source: QuerySource
  readonly tableNames: ReadonlyArray<string>
  readonly ctes: ReadonlyArray<CommonTableExpression>
  readonly capabilities: bigint
} => {
  if (input instanceof QueryReference) {
    return {
      source: input.source,
      tableNames: "query" in input.source ? input.source.query.annotations.tableNames : [input.source.name],
      ctes: input.cte ? [input.cte] : [],
      capabilities:
        "_tag" in input.source && input.source._tag === "TableFunctionSource"
          ? input.source.capabilities
          : noCapabilities
    }
  }
  const meta = tableMeta(input)
  return {
    source: { name: meta.name, ...(meta.alias ? { alias: meta.alias } : {}) },
    tableNames: [meta.name],
    ctes: [],
    capabilities: noCapabilities
  }
}

/**
 * Deduplicates CTE definitions by name while preserving first encounter order.
 *
 * @param groups - CTE groups to merge.
 * @returns Ordered unique CTE definitions.
 */
const mergeCtes = (
  ...groups: ReadonlyArray<ReadonlyArray<CommonTableExpression>>
): ReadonlyArray<CommonTableExpression> => {
  const seen = new Set<string>()
  return groups.flat().filter((cte) => {
    if (seen.has(cte.name)) return false
    seen.add(cte.name)
    return true
  })
}

// --- SELECT ------------------------------------------------------------------

/**
 * Immutable selectable query with terminal Effect-based execution methods.
 *
 * @stable
 */
class SelectQuery<A, P extends NamedParams = {}, F extends SelectFields = SelectFields> {
  /**
   * @param ir - Immutable select representation.
   * @param fields - Runtime fields used to decode result rows.
   */
  /** Memoized cardinality-probe IR for `.one()`/`.maybeOne()` (see below). */
  private probeIrCache?: SelectIR

  constructor(
    readonly ir: SelectIR,
    private readonly fields: SelectionField[]
  ) {}

  /**
   * @param patch - Select properties to replace.
   * @returns A new query preserving the current row decoder.
   */
  private clone(patch: Partial<SelectIR>): SelectQuery<A, P, F> {
    return new SelectQuery<A, P, F>({ ...this.ir, ...patch }, this.fields)
  }

  /**
   * The cardinality-probe IR for `.one()`/`.maybeOne()`: at most two rows are
   * ever needed to distinguish zero, one, and "too many" (spec §7.5, P0.5), so a
   * `.one()` never materializes an unbounded result set. A tighter user `limit`
   * (e.g. `limit(0)`/`limit(1)`) is preserved; the top-level `LIMIT` applies to
   * the final result of every shape — set operations, CTEs, GROUP BY, DISTINCT,
   * and OFFSET all render before it — so no wrapping select is required.
   *
   * @returns This query's IR, capped to at most two rows.
   */
  private cardinalityProbeIr(): SelectIR {
    if (this.probeIrCache) return this.probeIrCache
    const probe = Math.min(this.ir.limit ?? 2, 2)
    // Memoize a single capped IR object so repeated `.one()`/`.maybeOne()` calls
    // on the same query reuse one identity — otherwise the shape, compile, guard,
    // and parameter-plan caches (all keyed by IR identity) miss every call.
    this.probeIrCache = this.ir.limit === probe ? this.ir : { ...this.ir, limit: probe }
    return this.probeIrCache
  }

  /**
   * @param predicate - Predicate replacing the current `WHERE` clause.
   * @returns A new select query.
   */
  where<T extends ExprNode>(predicate: T): SelectQuery<A, MergeParams<P, ParamsOf<T>>, F> {
    return new SelectQuery<A, MergeParams<P, ParamsOf<T>>, F>(
      { ...this.ir, where: predicate, capabilities: this.ir.capabilities | expressionSyntaxCapabilities(predicate) },
      this.fields
    )
  }

  /**
   * Adds a relation using an inner join.
   *
   * @param source - Table, subquery, or CTE to join.
   * @param on - Join predicate evaluated with both sides in scope.
   * @returns A new select query.
   */
  join(source: QuerySourceInput, on: ExprNode): SelectQuery<A, P, F> {
    return this.addJoin("inner", source, on, false)
  }

  /**
   * @param source - Table, subquery, or CTE to join.
   * @param on - Join predicate.
   * @returns A new inner-joined select query.
   */
  innerJoin(source: QuerySourceInput, on: ExprNode): SelectQuery<A, P, F> {
    return this.addJoin("inner", source, on, false)
  }

  /**
   * @param source - Table, subquery, or CTE to join.
   * @param on - Join predicate.
   * @returns A new left-joined select query.
   */
  leftJoin<S extends QuerySourceInput>(source: S, on: ExprNode): SelectQuery<LeftJoined<A, F, SourceName<S>>, P, F> {
    return this.addJoin("left", source, on, false) as unknown as SelectQuery<LeftJoined<A, F, SourceName<S>>, P, F>
  }

  /**
   * @param source - Table, subquery, or CTE to join.
   * @param on - Join predicate.
   * @returns A new capability-gated right-joined select query.
   */
  rightJoin<S extends QuerySourceInput>(source: S, on: ExprNode): SelectQuery<RightJoined<A, F, SourceName<S>>, P, F> {
    return this.addJoin("right", source, on, false) as unknown as SelectQuery<RightJoined<A, F, SourceName<S>>, P, F>
  }

  /**
   * @param source - Table, subquery, or CTE to join.
   * @param on - Join predicate.
   * @returns A new capability-gated full-joined select query.
   */
  fullJoin(source: QuerySourceInput, on: ExprNode): SelectQuery<FullJoined<A>, P, F> {
    return this.addJoin("full", source, on, false) as unknown as SelectQuery<FullJoined<A>, P, F>
  }

  /**
   * @param source - Relation to cross join.
   * @returns A new cross-joined select query.
   */
  crossJoin(source: QuerySourceInput): SelectQuery<A, P, F> {
    return this.addJoin("cross", source, undefined, false)
  }

  /**
   * Adds a correlated lateral derived-table join.
   *
   * @param source - Derived query or CTE reference.
   * @param on - Optional join predicate; defaults to a cross lateral join.
   * @param type - Inner or left lateral join kind.
   * @returns A new capability-gated select query.
   */
  lateralJoin(
    source: QuerySourceInput,
    on?: ExprNode,
    type: Extract<JoinType, "inner" | "left" | "cross"> = on ? "inner" : "cross"
  ): SelectQuery<A, P, F> {
    return this.addJoin(type, source, on, true)
  }

  /**
   * @param type - Join kind.
   * @param input - Joined relation.
   * @param on - Optional join predicate.
   * @param lateral - Whether the joined relation can reference prior scope.
   * @returns A new select query.
   */
  private addJoin(
    type: JoinType,
    input: QuerySourceInput,
    on: ExprNode | undefined,
    lateral: boolean
  ): SelectQuery<A, P, F> {
    const resolved = resolveSource(input)
    const existingSources = new Set<string>([
      sourceVisibleName(this.ir.from),
      ...(this.ir.joins ?? []).map((join) => sourceVisibleName(join.source))
    ])
    const fields = fieldsForJoin(this.fields, type, existingSources, sourceVisibleName(resolved.source))
    let capabilities =
      this.ir.capabilities | resolved.capabilities | (on ? expressionSyntaxCapabilities(on) : noCapabilities)
    if (type === "right") capabilities |= capabilityBit("select.rightJoin")
    if (type === "full") capabilities |= capabilityBit("select.fullJoin")
    if (lateral) capabilities |= capabilityBit("select.lateralJoin")
    return new SelectQuery<A, P, F>(
      {
        ...this.ir,
        selection: fields,
        joins: [...(this.ir.joins ?? []), { type, source: resolved.source, ...(on ? { on } : {}), lateral }],
        ctes: mergeCtes(this.ir.ctes ?? [], resolved.ctes),
        capabilities,
        annotations: {
          ...this.ir.annotations,
          tableNames: [...new Set([...this.ir.annotations.tableNames, ...resolved.tableNames])]
        }
      },
      fields
    )
  }

  /**
   * Adds named CTE definitions even when they are not the root source.
   *
   * @param references - CTE references created by `db.cte` or `db.recursiveCte`.
   * @returns A new select query.
   */
  with(...references: ReadonlyArray<QueryReference<any>>): SelectQuery<A, P, F> {
    const ctes = references.flatMap((reference) => (reference.cte ? [reference.cte] : []))
    let capabilities = this.ir.capabilities
    for (const cte of ctes) {
      capabilities |= capabilityBit(cte.recursive ? "select.recursiveCte" : "select.cte")
    }
    return this.clone({ ctes: mergeCtes(this.ir.ctes ?? [], ctes), capabilities })
  }

  /** @returns A new `SELECT DISTINCT` query. */
  distinct(): SelectQuery<A, P, F> {
    return this.clone({ distinct: true })
  }

  /**
   * @param expressions - Grouping expressions.
   * @returns A grouped select query.
   */
  groupBy(...expressions: ReadonlyArray<ExpressionInput>): SelectQuery<A, P, F> {
    const nodes = expressions.map((expression) => (isColumn(expression) ? columnRef(expression) : expression.node))
    return this.clone({
      groupBy: [...(this.ir.groupBy ?? []), ...nodes],
      capabilities: nodes.reduce((bits, node) => bits | expressionSyntaxCapabilities(node), this.ir.capabilities)
    })
  }

  /**
   * @param predicate - Post-aggregation predicate.
   * @returns A select query with `HAVING`.
   */
  having(predicate: ExprNode): SelectQuery<A, P, F> {
    return this.clone({
      having: predicate,
      capabilities: this.ir.capabilities | expressionSyntaxCapabilities(predicate)
    })
  }

  /**
   * @param query - Compatible select appended with `UNION`.
   * @returns A set-operation query.
   */
  union(query: SelectQuery<A, P, F>): SelectQuery<A, P, F> {
    return this.addSetOperation("union", query, false)
  }

  /**
   * @param query - Compatible select appended with `UNION ALL`.
   * @returns A set-operation query.
   */
  unionAll(query: SelectQuery<A, P, F>): SelectQuery<A, P, F> {
    return this.addSetOperation("union", query, true)
  }

  /**
   * @param query - Compatible select appended with `INTERSECT`.
   * @returns A set-operation query.
   */
  intersect(query: SelectQuery<A, P, F>): SelectQuery<A, P, F> {
    return this.addSetOperation("intersect", query, false)
  }

  /**
   * @param query - Compatible select appended with `EXCEPT`.
   * @returns A set-operation query.
   */
  except(query: SelectQuery<A, P, F>): SelectQuery<A, P, F> {
    return this.addSetOperation("except", query, false)
  }

  /**
   * @param type - Set-operation kind.
   * @param query - Compatible right-hand select.
   * @param all - Whether duplicate rows are retained.
   * @returns A new set-operation query.
   */
  private addSetOperation(
    type: "union" | "intersect" | "except",
    query: SelectQuery<A, P, F>,
    all: boolean
  ): SelectQuery<A, P, F> {
    return this.clone({
      setOperations: [...(this.ir.setOperations ?? []), { type, query: query.ir, all }],
      capabilities: this.ir.capabilities | capabilityBit("select.setOperations"),
      annotations: {
        ...this.ir.annotations,
        tableNames: [...new Set([...this.ir.annotations.tableNames, ...query.ir.annotations.tableNames])]
      }
    })
  }

  /**
   * @param terms - Ordering terms appended in declaration order.
   * @returns A new select query.
   */
  orderBy(...terms: ReadonlyArray<OrderByTerm>): SelectQuery<A, P, F> {
    return this.clone({
      orderBy: [...this.ir.orderBy, ...terms],
      capabilities: terms.reduce((bits, term) => bits | expressionSyntaxCapabilities(term.expr), this.ir.capabilities)
    })
  }

  /**
   * @param n - Maximum number of rows. Must be a finite, non-negative safe integer.
   * @returns A new select query.
   * @throws {GuardError} When `n` is negative, non-integer, `NaN`, or `Infinity`.
   */
  limit(n: number): SelectQuery<A, P, F> {
    assertPaginationValue("limit", n)
    return this.clone({ limit: n, cardinality: n === 1 ? "one" : this.ir.cardinality })
  }

  /**
   * @param n - Number of rows to skip. Must be a finite, non-negative safe integer.
   * @returns A new select query.
   * @throws {GuardError} When `n` is negative, non-integer, `NaN`, or `Infinity`.
   */
  offset(n: number): SelectQuery<A, P, F> {
    assertPaginationValue("offset", n)
    return this.clone({ offset: n })
  }

  /**
   * @experimental Debugging shape only.
   * @returns Stable query-shape metadata without compiling or executing.
   */
  inspect() {
    return inspectIr(this.ir)
  }

  /**
   * Compiles the query without executing it.
   *
   * @param dialect - Target SQL dialect; defaults to PostgreSQL.
   * @returns SQL text, parameter order, and structural cache key.
   */
  toSql(dialect: Dialect = PostgresDialect): CompiledStatement {
    return dialect.compileQuery(this.ir)
  }

  /**
   * @returns Capabilities required to execute this query.
   */
  requiredCapabilities(): ReadonlyArray<Capability> {
    return bitsToCapabilities(queryCapabilityBits(this.ir))
  }

  /**
   * Executes the query and returns every decoded row.
   *
   * @stable
   * @typeParam Args - Omitted for compilation or no-param execution; otherwise named values.
   * @param args - Values for named query parameters.
   * @returns An Effect requiring `Database` and yielding decoded rows.
   */
  all<Args extends TerminalArguments<P>>(
    ...args: Args & ExactTerminalArguments<P, Args>
  ): TerminalCallResult<P, ReadonlyArray<A>, QueryError, "all", Args> {
    const effect = Effect.flatMap(Database, (db) => executeRows<A>(this.ir, this.fields, db, argsFrom(args)))
    return compilableEffect(effect, this.ir, this.fields, "all", executeCompiledRows<A>) as TerminalCallResult<
      P,
      ReadonlyArray<A>,
      QueryError,
      "all",
      Args
    >
  }

  /**
   * Executes the query and requires exactly one row.
   *
   * @stable
   * @typeParam Args - Omitted for compilation or no-param execution; otherwise named values.
   * @param args - Values for named query parameters.
   * @returns An Effect yielding the decoded row.
   * @throws {NotFoundError} Through the Effect error channel when no row exists.
   * @throws {TooManyRowsError} Through the Effect error channel when multiple rows exist.
   */
  one<Args extends TerminalArguments<P>>(
    ...args: Args & ExactTerminalArguments<P, Args>
  ): TerminalCallResult<P, A, QueryError | NotFoundError | TooManyRowsError, "one", Args> {
    const ir = this.cardinalityProbeIr()
    const effect = Effect.flatMap(
      Effect.flatMap(Database, (db) => executeRows<A>(ir, this.fields, db, argsFrom(args))),
      (rows) => exactlyOne(rows, "select.one")
    )
    return compilableEffect(effect, ir, this.fields, "one", (plan, statement, service, values) =>
      Effect.flatMap(executeCompiledRows<A>(plan, statement, service, values), (rows) => exactlyOne(rows, "select.one"))
    ) as TerminalCallResult<P, A, QueryError | NotFoundError | TooManyRowsError, "one", Args>
  }

  /**
   * Executes the query and accepts zero or one row.
   *
   * @stable
   * @typeParam Args - Omitted for compilation or no-param execution; otherwise named values.
   * @param args - Values for named query parameters.
   * @returns An Effect yielding `Option.none()` or `Option.some(row)`.
   * @throws {TooManyRowsError} Through the Effect error channel when multiple rows exist.
   */
  maybeOne<Args extends TerminalArguments<P>>(
    ...args: Args & ExactTerminalArguments<P, Args>
  ): TerminalCallResult<P, Option.Option<A>, QueryError | TooManyRowsError, "maybeOne", Args> {
    const ir = this.cardinalityProbeIr()
    const effect = Effect.flatMap(
      Effect.flatMap(Database, (db) => executeRows<A>(ir, this.fields, db, argsFrom(args))),
      (rows) => atMostOne(rows, "select.maybeOne")
    )
    return compilableEffect(effect, ir, this.fields, "maybeOne", (plan, statement, service, values) =>
      Effect.flatMap(executeCompiledRows<A>(plan, statement, service, values), (rows) =>
        atMostOne(rows, "select.maybeOne")
      )
    ) as TerminalCallResult<P, Option.Option<A>, QueryError | TooManyRowsError, "maybeOne", Args>
  }

  /**
   * Freeze this query into a reusable precompiled handle (spec §15.15).
   *
   * @experimental Prefer terminal `.compile()` for the v1 stable API.
   * @param name - Stable handle name for diagnostics/tracing (defaults to a generated id).
   * @returns A `PreparedQuery` that binds values per call and reuses compile/guard/decoder work.
   */
  prepare(name?: string): PreparedQuery<A, P> {
    return new PreparedQuery<A, P>(name ?? nextId("prepared"), this.ir, this.fields)
  }

  /**
   * @param name - Required derived-table alias.
   * @returns A relation reference exposing selected fields through `.field()`.
   */
  as(name: string): QueryReference<A> {
    return new QueryReference<A>({ _tag: "SubquerySource", query: this.ir, alias: internIdentifier(name) }, this.fields)
  }

  /**
   * @param name - CTE name.
   * @param recursive - Whether the enclosing clause uses `WITH RECURSIVE`.
   * @returns A named CTE relation reference.
   */
  cte(name: string, recursive = false): QueryReference<A> {
    const cteName = internIdentifier(name)
    const definition: CommonTableExpression = { name: cteName, query: this.ir, recursive }
    return new QueryReference<A>({ _tag: "CteSource", name: cteName }, this.fields, definition)
  }
}

/** Awaiting `from()`: holds the selection until a source is chosen. */
class SelectInit<A, F extends SelectFields = SelectFields> {
  /**
   * @param fields - Runtime fields used to decode selected rows.
   */
  constructor(private readonly fields: SelectionField[]) {}

  /**
   * @param input - Table, derived query, or CTE placed in the `FROM` clause.
   * @returns A selectable query.
   */
  from(input: QuerySourceInput): SelectQuery<A, {}, F> {
    const resolved = resolveSource(input)
    const cteCapabilities = resolved.ctes.reduce(
      (bits, cte) => bits | capabilityBit(cte.recursive ? "select.recursiveCte" : "select.cte"),
      noCapabilities
    )
    const ir: SelectIR = {
      _tag: "Select",
      id: nextId("Select"),
      from: resolved.source,
      selection: this.fields,
      ...(resolved.ctes.length > 0 ? { ctes: resolved.ctes } : {}),
      orderBy: [],
      capabilities: selectionSyntaxCapabilities(this.fields) | cteCapabilities | resolved.capabilities,
      cardinality: "many",
      annotations: { tableNames: [...resolved.tableNames] }
    }
    return new SelectQuery<A, {}, F>(ir, this.fields)
  }
}

// --- entrypoint --------------------------------------------------------------

/** @stable Pure query-builder entry point. No method touches a database until a terminal Effect is run. */
export const db = {
  /** Runs an Effect in a transaction; nested calls use savepoints. */
  transaction,
  /**
   * Wrap a `Database` layer to run in a safety/performance mode (spec §10).
   * `db`-level sugar over the layer wrapper of the same name.
   */
  withMode,
  /**
   * Wrap a `Database` layer to install a named, bounded query cache (spec §9.3).
   * `db`-level sugar over the layer wrapper of the same name.
   */
  withQueryCache,
  /** Wrap a `Database` layer with Effect tracing, metrics, and safe logging (spec §17). */
  withObservability,
  /**
   * @param fields - Output aliases mapped to columns or expressions.
   * @returns A select awaiting `from()`.
   */
  select: <F extends SelectFields>(fields: F): SelectInit<SelectResult<F>, F> => new SelectInit(selectionFrom(fields)),
  /**
   * @param table - Target table.
   * @returns An insert builder.
   */
  insert: <T extends AnyTable>(table: T): InsertBuilder<T> => new InsertBuilder(table),
  /**
   * @param table - Target table.
   * @returns An update builder.
   */
  update: <T extends AnyTable>(table: T): UpdateBuilder<T> => new UpdateBuilder(table),
  /**
   * @param table - Target table.
   * @returns A delete builder.
   */
  delete: <T extends AnyTable>(table: T): DeleteBuilder<T> => new DeleteBuilder(table),
  /**
   * @typeParam A - Selected CTE row type.
   * @param name - CTE name.
   * @param query - Query defining the CTE.
   * @returns A named relation reference for `from`, `join`, or `with`.
   */
  cte: <A>(name: string, query: SelectQuery<A>): QueryReference<A> => query.cte(name, false),
  /**
   * @typeParam A - Selected recursive CTE row type.
   * @param name - CTE name.
   * @param query - Query defining the recursive CTE body.
   * @returns A recursive named relation reference.
   */
  recursiveCte: <A>(name: string, query: SelectQuery<A>): QueryReference<A> => query.cte(name, true)
}

export { PreparedQuery }
export type { ReturningQuery, SelectQuery }
