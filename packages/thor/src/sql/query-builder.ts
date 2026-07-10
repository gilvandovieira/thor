/**
 * The fluent, pure query builder (spec §4.1, §6).
 *
 * Builders never touch the database — they assemble immutable IR. Only the
 * terminal methods (`all`/`one`/`maybeOne`/`run`) return an `Effect` that
 * requires the `Database` service.
 *
 * @module sql/query-builder
 */
import { Effect, Option, Schema } from "effect"
import type { AnyColumn, Column } from "../schema/column.js"
import { type AnyTable, type Insert as InsertInput, TableMeta, type Update as UpdateInput, tableMeta } from "../schema/table.js"
import {
  type CommonTableExpression,
  type ExprNode,
  type InsertConflict,
  type JoinType,
  type OrderByTerm,
  type QuerySource,
  type QueryIR,
  type SelectionField,
  type SelectIR,
  collectQueryParams,
  queryCapabilityBits,
  nextId
} from "../ir/query-ir.js"
import { capabilityBit, type Capability, bitsToCapabilities, noCapabilities } from "../capabilities/capability.js"
import type { Dialect } from "../dialect.js"
import { PostgresDialect } from "../postgres/dialect.js"
import type { QueryError, NotFoundError, TooManyRowsError } from "../errors/index.js"
import { Database } from "../execution/database.js"
import {
  atMostOne,
  exactlyOne,
  executeCommand,
  executeCompiledCommand,
  executeCompiledRows,
  executePreparedCommand,
  executePreparedRows,
  executeRows,
  PreparedExecutionPlan,
  type QueryArgs
} from "../execution/run.js"
import type { CommandResult, CompiledStatement } from "../execution/driver.js"
import { compilableEffect, type TerminalResult } from "../execution/compiled-query.js"
import { withMode, withQueryCache } from "../execution/plan.js"
import {
  type Expr,
  type MergeParameterMaps,
  type Param,
  type ParamsOf,
  columnRef,
  isColumn,
  toValueNode
} from "./expressions.js"
import { type ExpressionInput } from "./advanced-expressions.js"
import { internIdentifier } from "../ir/identifiers.js"
import { transaction } from "../execution/transaction.js"

// --- selection typing --------------------------------------------------------

type SelectFields = Record<string, AnyColumn | Expr<any>>

type FieldValue<T> = T extends Column<infer C>
  ? C extends { readonly data: infer D }
    ? C extends { readonly notNull: true }
      ? D
      : D | null
    : unknown
  : T extends Expr<infer A>
    ? A
    : unknown

type SelectResult<F extends SelectFields> = { [K in keyof F]: FieldValue<F[K]> } & {}
type SourceName<T> = T extends { readonly [TableMeta]: { readonly name: infer Name extends string } } ? Name : string
type FieldSource<T> = T extends Column<infer C>
  ? C extends { readonly table: infer Name extends string } ? Name : never
  : never
type LeftJoined<A, F extends SelectFields, Name extends string> = {
  [K in keyof A]: K extends keyof F
    ? [FieldSource<F[K]>] extends [never] ? A[K]
      : FieldSource<F[K]> extends Name ? A[K] | null : A[K]
    : A[K]
}
type RightJoined<A, F extends SelectFields, Name extends string> = {
  [K in keyof A]: K extends keyof F
    ? [FieldSource<F[K]>] extends [never] ? A[K] | null
      : FieldSource<F[K]> extends Name ? A[K] : A[K] | null
    : A[K]
}
type FullJoined<A> = { [K in keyof A]: A[K] | null }

type NamedParams = Record<string, unknown>
type MergeParams<A extends NamedParams, B extends NamedParams> = { [K in keyof A | keyof B]:
  K extends keyof B ? B[K] : K extends keyof A ? A[K] : never }
type ExecutionArguments<P extends NamedParams> = keyof P extends never
  ? [args?: Record<string, never>]
  : [args: { [K in keyof P]: P[K] }]
type TerminalArguments<P extends NamedParams> = ExecutionArguments<P> | []
type ExactTerminalArguments<P extends NamedParams, Args extends TerminalArguments<P>> = Args extends []
  ? Args
  : Args extends [infer Input]
    ? Exclude<keyof Input, keyof P> extends never ? Args : never
    : never
type TerminalCallResult<
  P extends NamedParams,
  Output,
  Error,
  Cardinality extends import("../execution/compiled-query.js").CompiledCardinality,
  Args extends TerminalArguments<P>
> = Args extends []
  ? TerminalResult<P, Output, Error, Cardinality>
  : Effect.Effect<Output, Error, Database>

/**
 * @param args - Optional terminal-method argument tuple.
 * @returns The supplied named arguments or an empty map.
 */
const argsFrom = (args: readonly [QueryArgs?]): QueryArgs => args[0] ?? {}

const NO_SELECTION: ReadonlyArray<SelectionField> = Object.freeze([])

type ParameterizedValue<A> = A | Param<string, Exclude<A, undefined>> | Expr<Exclude<A, undefined>>
type ParameterizedInput<T> = { [K in keyof T]: ParameterizedValue<T[K]> }
type InputParams<T> = T extends ReadonlyArray<infer R>
  ? InputParams<R>
  : T extends Record<string, unknown>
    ? MergeParameterMaps<ParamsOf<T[keyof T]>>
    : {}

/**
 * Converts a selected column or expression into runtime selection metadata.
 *
 * @param alias - Output property name.
 * @param value - Selected column or expression.
 * @returns A field carrying the expression and row decoder.
 */
const toSelectionField = (alias: string, value: AnyColumn | Expr<any>): SelectionField => {
  const outputAlias = internIdentifier(alias)
  if (isColumn(value)) {
    const codec = value.def.notNull ? value.def.codec : Schema.NullOr(value.def.codec)
    return { alias: outputAlias, expr: columnRef(value), codec }
  }
  const expression = value as Expr<any>
  return { alias: outputAlias, expr: expression.node, codec: expression.codec ?? Schema.Unknown }
}

/**
 * Converts an aliased field map into an ordered runtime selection.
 *
 * @param fields - Output aliases mapped to columns or expressions.
 * @returns Selection metadata in object insertion order.
 */
const selectionFrom = (fields: SelectFields): SelectionField[] =>
  Object.entries(fields).map(([alias, value]) => toSelectionField(alias, value))

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
      return node.args.reduce(
        (bits, arg) => bits | expressionSyntaxCapabilities(arg),
        node.capabilities
      )
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
): SelectionField[] => fields.map((field) => {
  // Non-column expressions can resolve over the null-extended side, so mirror the
  // RightJoined/FullJoined row types (which mark them nullable) in the decoder.
  if (field.expr._tag !== "ColumnRef") return type === "full" || type === "right" ? nullableField(field) : field
  const nullable = type === "full" ||
    (type === "left" && field.expr.table === joinedSource) ||
    (type === "right" && existingSources.has(field.expr.table))
  return nullable ? nullableField(field) : field
})

/**
 * Builds a star selection with one decoded field per table column.
 *
 * @param table - Table whose columns should be selected.
 * @returns Runtime selection metadata in declaration order.
 */
const starSelection = (table: AnyTable): SelectionField[] =>
  Object.entries(tableMeta(table).columns).map(([alias, column]) => toSelectionField(alias, column))

/** Query-local named relation backed by a select query. */
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
    const table = "_tag" in this.source && this.source._tag === "SubquerySource"
      ? this.source.alias
      : this.source.alias ?? this.source.name
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
const resolveSource = (input: QuerySourceInput): {
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
      capabilities: "_tag" in input.source && input.source._tag === "TableFunctionSource"
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
const mergeCtes = (...groups: ReadonlyArray<ReadonlyArray<CommonTableExpression>>): ReadonlyArray<CommonTableExpression> => {
  const seen = new Set<string>()
  return groups.flat().filter((cte) => {
    if (seen.has(cte.name)) return false
    seen.add(cte.name)
    return true
  })
}

// --- shared inspection -------------------------------------------------------

/**
 * Produces stable, serializable query metadata for diagnostics.
 *
 * @param ir - Query representation to inspect.
 * @returns Query kind, tables, parameters, cardinality, and capabilities.
 */
const inspectIr = (ir: QueryIR) => ({
  kind: ir._tag,
  tables: ir.annotations.tableNames,
  params: collectQueryParams(ir).map((parameter) => parameter.name),
  cardinality: ir.cardinality,
  capabilities: bitsToCapabilities(queryCapabilityBits(ir)),
  operationName: ir.annotations.operationName,
  tracing: ir.annotations.tracing
})

// --- PREPARED ----------------------------------------------------------------

/**
 * A precompiled, reusable query handle (spec §15.13, §15.15).
 *
 * `.prepare()` hoists per-call work out of the hot path: the IR is frozen, the
 * row decoder is precompiled at construction, and compilation + guarding are
 * memoized per dialect on first execution and reused thereafter. Values are
 * always bound separately per call — a handle never captures parameter values
 * (spec §15.17), so one handle serves every value combination.
 *
 * Hoist a handle to module scope for hot paths:
 * ```ts
 * const FindUserByEmail = db.select({ id: users.id }).from(users)
 *   .where(eq(users.email, param("email", Schema.String)))
 *   .prepare("FindUserByEmail")
 *
 * yield* FindUserByEmail.one({ email })
 * ```
 */
export class PreparedQuery<A, P extends NamedParams = {}> {
  private readonly plan: PreparedExecutionPlan

  /**
   * @param name - Stable handle name used in diagnostics and tracing.
   * @param ir - Frozen query representation.
   * @param fields - Runtime fields used to decode result rows.
   */
  constructor(
    readonly name: string,
    ir: QueryIR,
    fields: SelectionField[]
  ) {
    this.plan = new PreparedExecutionPlan({
      ...ir,
      annotations: {
        ...ir.annotations,
        operationName: name,
        tracing: {
          spanName: name,
          attributes: { "db.query.kind": ir._tag, "db.query.tables": ir.annotations.tableNames.join(",") }
        }
      }
    }, fields)
  }

  /** @returns Stable query-shape metadata without compiling or executing. */
  inspect() {
    return { ...inspectIr(this.plan.ir), prepared: { name: this.name, ...this.plan.inspect() } }
  }

  /**
   * @param dialect - Target SQL dialect; defaults to PostgreSQL.
   * @returns Compiled SQL, parameter order, and cache key.
   */
  toSql(dialect: Dialect = PostgresDialect): CompiledStatement {
    return this.plan.compile(dialect)
  }

  /** @returns Capabilities required to execute this handle. */
  requiredCapabilities(): ReadonlyArray<Capability> {
    return bitsToCapabilities(this.plan.capabilityBits)
  }

  /**
   * @param args - Values for named query parameters.
   * @returns An Effect yielding every decoded row.
   */
  all(...args: ExecutionArguments<P>): Effect.Effect<ReadonlyArray<A>, QueryError, Database> {
    return Effect.flatMap(Database, (db) => executePreparedRows<A>(this.plan, db, argsFrom(args)))
  }

  /**
   * @param args - Values for named query parameters.
   * @returns An Effect yielding exactly one decoded row.
   * @throws {NotFoundError} Through the Effect error channel when no row exists.
   * @throws {TooManyRowsError} Through the Effect error channel when multiple rows exist.
   */
  one(...args: ExecutionArguments<P>): Effect.Effect<A, QueryError | NotFoundError | TooManyRowsError, Database> {
    return Effect.flatMap(this.all(...args), (rows) => exactlyOne(rows, `${this.name}.one`))
  }

  /**
   * @param args - Values for named query parameters.
   * @returns An Effect yielding zero or one decoded row.
   * @throws {TooManyRowsError} Through the Effect error channel when multiple rows exist.
   */
  maybeOne(...args: ExecutionArguments<P>): Effect.Effect<Option.Option<A>, QueryError | TooManyRowsError, Database> {
    return Effect.flatMap(this.all(...args), (rows) => atMostOne(rows, `${this.name}.maybeOne`))
  }

  /**
   * Execute as a command (for prepared mutations), returning the affected count.
   *
   * @param args - Values for named query parameters.
   * @returns An Effect yielding the affected-row count.
   */
  run(...args: ExecutionArguments<P>): Effect.Effect<CommandResult, QueryError, Database> {
    return Effect.flatMap(Database, (db) => executePreparedCommand(this.plan, db, argsFrom(args)))
  }
}

// --- SELECT ------------------------------------------------------------------

/** Immutable selectable query with terminal Effect-based execution methods. */
class SelectQuery<A, P extends NamedParams = {}, F extends SelectFields = SelectFields> {
  /**
   * @param ir - Immutable select representation.
   * @param fields - Runtime fields used to decode result rows.
   */
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
   * @param predicate - Predicate replacing the current `WHERE` clause.
   * @returns A new select query.
   */
  where<T extends ExprNode>(predicate: T): SelectQuery<A, MergeParams<P, ParamsOf<T>>, F> {
    return new SelectQuery<A, MergeParams<P, ParamsOf<T>>, F>({ ...this.ir,
      where: predicate,
      capabilities: this.ir.capabilities | expressionSyntaxCapabilities(predicate)
    }, this.fields)
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
  private addJoin(type: JoinType, input: QuerySourceInput, on: ExprNode | undefined, lateral: boolean): SelectQuery<A, P, F> {
    const resolved = resolveSource(input)
    const existingSources = new Set<string>([
      sourceVisibleName(this.ir.from),
      ...(this.ir.joins ?? []).map((join) => sourceVisibleName(join.source))
    ])
    const fields = fieldsForJoin(this.fields, type, existingSources, sourceVisibleName(resolved.source))
    let capabilities = this.ir.capabilities | resolved.capabilities | (on ? expressionSyntaxCapabilities(on) : noCapabilities)
    if (type === "right") capabilities |= capabilityBit("select.rightJoin")
    if (type === "full") capabilities |= capabilityBit("select.fullJoin")
    if (lateral) capabilities |= capabilityBit("select.lateralJoin")
    return new SelectQuery<A, P, F>({ ...this.ir,
      selection: fields,
      joins: [...(this.ir.joins ?? []), { type, source: resolved.source, ...(on ? { on } : {}), lateral }],
      ctes: mergeCtes(this.ir.ctes ?? [], resolved.ctes),
      capabilities,
      annotations: {
        ...this.ir.annotations,
        tableNames: [...new Set([...this.ir.annotations.tableNames, ...resolved.tableNames])]
      }
    }, fields)
  }

  /**
   * Adds named CTE definitions even when they are not the root source.
   *
   * @param references - CTE references created by `db.cte` or `db.recursiveCte`.
   * @returns A new select query.
   */
  with(...references: ReadonlyArray<QueryReference<any>>): SelectQuery<A, P, F> {
    const ctes = references.flatMap((reference) => reference.cte ? [reference.cte] : [])
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
    const nodes = expressions.map((expression) => isColumn(expression) ? columnRef(expression) : expression.node)
    return this.clone({
      groupBy: [...(this.ir.groupBy ?? []), ...nodes],
      capabilities: nodes.reduce(
        (bits, node) => bits | expressionSyntaxCapabilities(node),
        this.ir.capabilities
      )
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
  private addSetOperation(type: "union" | "intersect" | "except", query: SelectQuery<A, P, F>, all: boolean): SelectQuery<A, P, F> {
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
      capabilities: terms.reduce(
        (bits, term) => bits | expressionSyntaxCapabilities(term.expr),
        this.ir.capabilities
      )
    })
  }

  /**
   * @param n - Maximum number of rows.
   * @returns A new select query.
   */
  limit(n: number): SelectQuery<A, P, F> {
    return this.clone({ limit: n, cardinality: n === 1 ? "one" : this.ir.cardinality })
  }

  /**
   * @param n - Number of rows to skip.
   * @returns A new select query.
   */
  offset(n: number): SelectQuery<A, P, F> {
    return this.clone({ offset: n })
  }

  /**
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
   * @typeParam Args - Omitted for compilation or no-param execution; otherwise named values.
   * @param args - Values for named query parameters.
   * @returns An Effect requiring `Database` and yielding decoded rows.
   */
  all<Args extends TerminalArguments<P>>(...args: Args & ExactTerminalArguments<P, Args>): TerminalCallResult<P, ReadonlyArray<A>, QueryError, "all", Args> {
    const effect = Effect.flatMap(Database, (db) => executeRows<A>(this.ir, this.fields, db, argsFrom(args)))
    return compilableEffect(effect, this.ir, this.fields, "all", executeCompiledRows<A>) as TerminalCallResult<P, ReadonlyArray<A>, QueryError, "all", Args>
  }

  /**
   * Executes the query and requires exactly one row.
   *
   * @typeParam Args - Omitted for compilation or no-param execution; otherwise named values.
   * @param args - Values for named query parameters.
   * @returns An Effect yielding the decoded row.
   * @throws {NotFoundError} Through the Effect error channel when no row exists.
   * @throws {TooManyRowsError} Through the Effect error channel when multiple rows exist.
   */
  one<Args extends TerminalArguments<P>>(...args: Args & ExactTerminalArguments<P, Args>): TerminalCallResult<P, A, QueryError | NotFoundError | TooManyRowsError, "one", Args> {
    const effect = Effect.flatMap(
      Effect.flatMap(Database, (db) => executeRows<A>(this.ir, this.fields, db, argsFrom(args))),
      (rows) => exactlyOne(rows, "select.one")
    )
    return compilableEffect(effect, this.ir, this.fields, "one", (plan, statement, service, values) =>
      Effect.flatMap(executeCompiledRows<A>(plan, statement, service, values), (rows) => exactlyOne(rows, "select.one"))
    ) as TerminalCallResult<P, A, QueryError | NotFoundError | TooManyRowsError, "one", Args>
  }

  /**
   * Executes the query and accepts zero or one row.
   *
   * @typeParam Args - Omitted for compilation or no-param execution; otherwise named values.
   * @param args - Values for named query parameters.
   * @returns An Effect yielding `Option.none()` or `Option.some(row)`.
   * @throws {TooManyRowsError} Through the Effect error channel when multiple rows exist.
   */
  maybeOne<Args extends TerminalArguments<P>>(...args: Args & ExactTerminalArguments<P, Args>): TerminalCallResult<P, Option.Option<A>, QueryError | TooManyRowsError, "maybeOne", Args> {
    const effect = Effect.flatMap(
      Effect.flatMap(Database, (db) => executeRows<A>(this.ir, this.fields, db, argsFrom(args))),
      (rows) => atMostOne(rows, "select.maybeOne")
    )
    return compilableEffect(effect, this.ir, this.fields, "maybeOne", (plan, statement, service, values) =>
      Effect.flatMap(executeCompiledRows<A>(plan, statement, service, values), (rows) => atMostOne(rows, "select.maybeOne"))
    ) as TerminalCallResult<P, Option.Option<A>, QueryError | TooManyRowsError, "maybeOne", Args>
  }

  /**
   * Freeze this query into a reusable precompiled handle (spec §15.15).
   *
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

// --- INSERT ------------------------------------------------------------------

/**
 * Maps an application insert object to physical columns and parameter nodes.
 *
 * @param table - Target table definition.
 * @param input - Application-level insert values.
 * @returns Ordered column names and their parameter expressions.
 */
const valuesToRow = (table: AnyTable, input: Record<string, unknown>): { columns: string[]; row: ExprNode[] } => {
  const meta = tableMeta(table)
  const columns: string[] = []
  const row: ExprNode[] = []
  for (const [key, value] of Object.entries(input)) {
    const column = meta.columns[key]
    if (!column) continue
    columns.push(column.def.name)
    row.push(inputValueNode(meta.name, column, value))
  }
  return { columns, row }
}

/**
 * Converts a mutation input to either a named expression or an inline-bound parameter.
 *
 * @param table - Physical table name used for inline parameter diagnostics.
 * @param column - Target schema column and codec.
 * @param value - Application value, named parameter, or expression.
 * @returns Runtime expression used by insert and update IR.
 */
const inputValueNode = (table: string, column: AnyColumn, value: unknown): ExprNode => {
  if (
    typeof value === "object" &&
    value !== null &&
    (("_tag" in value && value._tag === "Param") || "node" in value)
  ) {
    return toValueNode(value, column)
  }
  return { _tag: "Param", name: `${table}.${column.def.name}`, codec: column.def.codec, value }
}

/**
 * Converts application update input into physical assignments.
 *
 * @param table - Target table.
 * @param input - Application-keyed update values.
 * @returns Ordered physical assignments.
 */
const assignmentsFrom = (
  table: AnyTable,
  input: Record<string, unknown>
): ReadonlyArray<{ readonly column: string; readonly value: ExprNode }> => {
  const meta = tableMeta(table)
  return Object.entries(input).flatMap(([key, value]) => {
    const column = meta.columns[key]
    return column
      ? [{ column: column.def.name, value: inputValueNode(meta.name, column, value) }]
      : []
  })
}

/** Insert, update, or delete query with a decoded `RETURNING` selection. */
class ReturningQuery<A, P extends NamedParams = {}> {
  /**
   * @param ir - Data-modification representation containing `RETURNING`.
   * @param fields - Runtime fields used to decode returned rows.
   */
  constructor(
    readonly ir: Exclude<QueryIR, SelectIR>,
    private readonly fields: SelectionField[]
  ) {}

  /**
   * @returns Stable query-shape metadata without compiling or executing.
   */
  inspect() {
    return inspectIr(this.ir)
  }

  /**
   * @param dialect - Target SQL dialect; defaults to PostgreSQL.
   * @returns Compiled query data.
   */
  toSql(dialect: Dialect = PostgresDialect): CompiledStatement {
    return dialect.compileQuery(this.ir)
  }

  /**
   * @returns Capabilities required to execute this returning query.
   */
  requiredCapabilities(): ReadonlyArray<Capability> {
    return bitsToCapabilities(queryCapabilityBits(this.ir))
  }

  /**
   * @typeParam Args - Omitted for compilation or no-param execution; otherwise named values.
   * @param args - Named parameter values.
   * @returns An Effect yielding every returned row.
   */
  all<Args extends TerminalArguments<P>>(...args: Args & ExactTerminalArguments<P, Args>): TerminalCallResult<P, ReadonlyArray<A>, QueryError, "all", Args> {
    const effect = Effect.flatMap(Database, (db) => executeRows<A>(this.ir, this.fields, db, argsFrom(args)))
    return compilableEffect(effect, this.ir, this.fields, "all", executeCompiledRows<A>) as TerminalCallResult<P, ReadonlyArray<A>, QueryError, "all", Args>
  }

  /**
   * @typeParam Args - Omitted for compilation or no-param execution; otherwise named values.
   * @param args - Named parameter values.
   * @returns An Effect yielding exactly one returned row.
   * @throws {NotFoundError} Through the Effect error channel when no row is returned.
   * @throws {TooManyRowsError} Through the Effect error channel when multiple rows are returned.
   */
  one<Args extends TerminalArguments<P>>(...args: Args & ExactTerminalArguments<P, Args>): TerminalCallResult<P, A, QueryError | NotFoundError | TooManyRowsError, "one", Args> {
    const operation = `${this.ir._tag}.one`
    const effect = Effect.flatMap(
      Effect.flatMap(Database, (db) => executeRows<A>(this.ir, this.fields, db, argsFrom(args))),
      (rows) => exactlyOne(rows, operation)
    )
    return compilableEffect(effect, this.ir, this.fields, "one", (plan, statement, service, values) =>
      Effect.flatMap(executeCompiledRows<A>(plan, statement, service, values), (rows) => exactlyOne(rows, operation))
    ) as TerminalCallResult<P, A, QueryError | NotFoundError | TooManyRowsError, "one", Args>
  }

  /**
   * @typeParam Args - Omitted for compilation or no-param execution; otherwise named values.
   * @param args - Named parameter values.
   * @returns An Effect yielding zero or one returned row.
   * @throws {TooManyRowsError} Through the Effect error channel when multiple rows are returned.
   */
  maybeOne<Args extends TerminalArguments<P>>(...args: Args & ExactTerminalArguments<P, Args>): TerminalCallResult<P, Option.Option<A>, QueryError | TooManyRowsError, "maybeOne", Args> {
    const operation = `${this.ir._tag}.maybeOne`
    const effect = Effect.flatMap(
      Effect.flatMap(Database, (db) => executeRows<A>(this.ir, this.fields, db, argsFrom(args))),
      (rows) => atMostOne(rows, operation)
    )
    return compilableEffect(effect, this.ir, this.fields, "maybeOne", (plan, statement, service, values) =>
      Effect.flatMap(executeCompiledRows<A>(plan, statement, service, values), (rows) => atMostOne(rows, operation))
    ) as TerminalCallResult<P, Option.Option<A>, QueryError | TooManyRowsError, "maybeOne", Args>
  }

  /**
   * @typeParam Args - Omitted for compilation or no-param execution; otherwise named values.
   * @param args - Named parameter values.
   * @returns An Effect yielding the affected-row count.
   */
  run<Args extends TerminalArguments<P>>(...args: Args & ExactTerminalArguments<P, Args>): TerminalCallResult<P, CommandResult, QueryError, "run", Args> {
    const effect = Effect.flatMap(Database, (db) => executeCommand(this.ir, db, argsFrom(args)))
    return compilableEffect(effect, this.ir, this.fields, "run", executeCompiledCommand) as TerminalCallResult<P, CommandResult, QueryError, "run", Args>
  }

  /**
   * Freeze this returning mutation into a reusable precompiled handle (spec §15.15).
   *
   * @param name - Stable handle name (defaults to a generated id).
   * @returns A `PreparedQuery` exposing `all`/`one`/`maybeOne`/`run`.
   */
  prepare(name?: string): PreparedQuery<A, P> {
    return new PreparedQuery<A, P>(name ?? nextId("prepared"), this.ir, this.fields)
  }
}

/**
 * Resolves an explicit `RETURNING` selection or the table's star selection.
 *
 * @param table - Target table.
 * @param fields - Optional explicit return fields.
 * @returns Runtime selection metadata.
 */
const returningFields = (table: AnyTable, fields?: SelectFields): SelectionField[] =>
  fields ? selectionFrom(fields) : starSelection(table)

class InsertBuilder<T extends AnyTable> {
  /**
   * @param table - Target table.
   */
  constructor(private readonly table: T) {}

  /**
   * Adds one or more rows to an insert.
   *
   * @param input - A single insert value or homogeneous array of values.
   * @returns An insert builder ready for `returning()` or `run()`.
   */
  values<I extends ParameterizedInput<InsertInput<T>> | ReadonlyArray<ParameterizedInput<InsertInput<T>>>>(
    input: I
  ): InsertValues<T, InputParams<I>> {
    const list = (Array.isArray(input) ? input : [input]) as ReadonlyArray<Record<string, unknown>>
    const first = valuesToRow(this.table, list[0] ?? {})
    const rows = list.map((r) => valuesToRow(this.table, r).row)
    return new InsertValues<T, InputParams<I>>(this.table, first.columns, rows)
  }
}

class InsertValues<T extends AnyTable, P extends NamedParams = {}> {
  /**
   * @param table - Target table.
   * @param columns - Physical columns included by the insert.
   * @param rows - Parameter expressions for every inserted row.
   * @param conflict - Optional dialect-specific conflict policy.
   */
  constructor(
    private readonly table: T,
    private readonly columns: string[],
    private readonly rows: ExprNode[][],
    private readonly conflict?: InsertConflict
  ) {}

  /**
   * @param returning - Optional returned-field metadata.
   * @returns Insert runtime representation.
   */
  private ir(returning?: SelectionField[]): Exclude<QueryIR, SelectIR> {
    const meta = tableMeta(this.table)
    return {
      _tag: "Insert",
      id: nextId("Insert"),
      into: { name: meta.name },
      columns: this.columns,
      rows: this.rows,
      ...(this.conflict ? { conflict: this.conflict } : {}),
      ...(returning ? { returning } : {}),
      capabilities:
        (returning ? capabilityBit("insert.returning") : noCapabilities) |
        (this.conflict?.kind === "onConflict" ? capabilityBit("insert.onConflict") : noCapabilities) |
        (this.conflict?.kind === "onDuplicateKey" ? capabilityBit("insert.onDuplicateKey") : noCapabilities),
      cardinality: this.rows.length === 1 ? "one" : "many",
      annotations: { tableNames: [meta.name], idempotency: "non-idempotent" }
    }
  }

  /** @returns Stable insert-shape metadata without executing. */
  inspect() {
    return inspectIr(this.ir())
  }

  /**
   * @param dialect - Target SQL dialect; defaults to PostgreSQL.
   * @returns Compiled insert SQL and parameter metadata.
   */
  toSql(dialect: Dialect = PostgresDialect): CompiledStatement {
    return dialect.compileQuery(this.ir())
  }

  /** @returns Capabilities required by this insert. */
  requiredCapabilities(): ReadonlyArray<Capability> {
    return bitsToCapabilities(queryCapabilityBits(this.ir()))
  }

  /**
   * Adds a PostgreSQL/SQLite-style `ON CONFLICT DO NOTHING` policy.
   *
   * @param target - Optional conflict-target columns.
   * @returns A new insert builder guarded by `insert.onConflict`.
   */
  onConflictDoNothing(target: ReadonlyArray<AnyColumn> = []): InsertValues<T, P> {
    return new InsertValues<T, P>(this.table, this.columns, this.rows, {
      kind: "onConflict",
      target: target.map((column) => column.def.name),
      action: "nothing",
      set: []
    })
  }

  /**
   * Adds a PostgreSQL/SQLite-style `ON CONFLICT DO UPDATE` policy.
   *
   * @param target - Conflict-target columns.
   * @param input - Assignments applied to the conflicting row.
   * @returns A new insert builder guarded by `insert.onConflict`.
   */
  onConflictDoUpdate<I extends ParameterizedInput<UpdateInput<T>>>(
    target: ReadonlyArray<AnyColumn>,
    input: I
  ): InsertValues<T, MergeParams<P, InputParams<I>>> {
    return new InsertValues<T, MergeParams<P, InputParams<I>>>(this.table, this.columns, this.rows, {
      kind: "onConflict",
      target: target.map((column) => column.def.name),
      action: "update",
      set: assignmentsFrom(this.table, input as Record<string, unknown>)
    })
  }

  /**
   * Adds a MySQL-style `ON DUPLICATE KEY UPDATE` policy.
   *
   * @param input - Assignments applied to the conflicting row.
   * @returns A new insert builder guarded by `insert.onDuplicateKey`.
   */
  onDuplicateKeyUpdate<I extends ParameterizedInput<UpdateInput<T>>>(input: I): InsertValues<T, MergeParams<P, InputParams<I>>> {
    return new InsertValues<T, MergeParams<P, InputParams<I>>>(this.table, this.columns, this.rows, {
      kind: "onDuplicateKey",
      set: assignmentsFrom(this.table, input as Record<string, unknown>)
    })
  }

  /**
   * Adds a `RETURNING` clause.
   *
   * @param fields - Optional selected fields; omit to return every table column.
   * @returns A row-returning query guarded by dialect capabilities.
   */
  returning<F extends SelectFields>(fields?: F): ReturningQuery<F extends SelectFields ? SelectResult<F> : Record<string, unknown>, P> {
    const selection = returningFields(this.table, fields)
    return new ReturningQuery(this.ir(selection), selection)
  }

  /**
   * @typeParam Args - Omitted for compilation or no-param execution; otherwise named values.
   * @param args - Named parameter values.
   * @returns An Effect yielding the affected-row count.
   */
  run<Args extends TerminalArguments<P>>(...args: Args & ExactTerminalArguments<P, Args>): TerminalCallResult<P, CommandResult, QueryError, "run", Args> {
    const ir = this.ir()
    const effect = Effect.flatMap(Database, (db) => executeCommand(ir, db, argsFrom(args)))
    return compilableEffect(effect, ir, NO_SELECTION, "run", executeCompiledCommand) as TerminalCallResult<P, CommandResult, QueryError, "run", Args>
  }
}

// --- UPDATE ------------------------------------------------------------------

class UpdateBuilder<T extends AnyTable> {
  /**
   * @param table - Target table.
   */
  constructor(private readonly table: T) {}

  /**
   * @param input - Partial non-generated column values.
   * @returns An update builder with assignments.
   */
  set<I extends ParameterizedInput<UpdateInput<T>>>(input: I): UpdateValues<T, InputParams<I>> {
    return new UpdateValues<T, InputParams<I>>(this.table, assignmentsFrom(this.table, input as Record<string, unknown>))
  }
}

class UpdateValues<T extends AnyTable, P extends NamedParams = {}> {
  private whereNode?: ExprNode

  /**
   * @param table - Target table.
   * @param assignments - Physical column assignments.
   * @param whereNode - Optional predicate retained by an immutable clone.
   */
  constructor(
    private readonly table: T,
    private readonly assignments: ReadonlyArray<{ column: string; value: ExprNode }>,
    whereNode?: ExprNode
  ) {
    if (whereNode !== undefined) this.whereNode = whereNode
  }

  /**
   * @param predicate - Predicate replacing the current `WHERE` clause.
   * @returns This update builder.
   */
  where<E extends ExprNode>(predicate: E): UpdateValues<T, MergeParams<P, ParamsOf<E>>> {
    return new UpdateValues<T, MergeParams<P, ParamsOf<E>>>(this.table, this.assignments, predicate)
  }

  /**
   * @param returning - Optional returned-field metadata.
   * @returns Update runtime representation.
   */
  private ir(returning?: SelectionField[]): Exclude<QueryIR, SelectIR> {
    const meta = tableMeta(this.table)
    return {
      _tag: "Update",
      id: nextId("Update"),
      table: { name: meta.name },
      set: this.assignments,
      ...(this.whereNode ? { where: this.whereNode } : {}),
      ...(returning ? { returning } : {}),
      capabilities: returning ? capabilityBit("update.returning") : noCapabilities,
      cardinality: "many",
      annotations: { tableNames: [meta.name], idempotency: "unknown" }
    }
  }

  /** @returns Stable update-shape metadata without executing. */
  inspect() {
    return inspectIr(this.ir())
  }

  /**
   * @param dialect - Target SQL dialect; defaults to PostgreSQL.
   * @returns Compiled update SQL and parameter metadata.
   */
  toSql(dialect: Dialect = PostgresDialect): CompiledStatement {
    return dialect.compileQuery(this.ir())
  }

  /** @returns Capabilities required by this update. */
  requiredCapabilities(): ReadonlyArray<Capability> {
    return bitsToCapabilities(queryCapabilityBits(this.ir()))
  }

  /**
   * @param fields - Optional fields to return; omit for all columns.
   * @returns A row-returning update query.
   */
  returning<F extends SelectFields>(fields?: F): ReturningQuery<F extends SelectFields ? SelectResult<F> : Record<string, unknown>, P> {
    const selection = returningFields(this.table, fields)
    return new ReturningQuery(this.ir(selection), selection)
  }

  /**
   * @typeParam Args - Omitted for compilation or no-param execution; otherwise named values.
   * @param args - Named parameter values.
   * @returns An Effect yielding the affected-row count.
   */
  run<Args extends TerminalArguments<P>>(...args: Args & ExactTerminalArguments<P, Args>): TerminalCallResult<P, CommandResult, QueryError, "run", Args> {
    const ir = this.ir()
    const effect = Effect.flatMap(Database, (db) => executeCommand(ir, db, argsFrom(args)))
    return compilableEffect(effect, ir, NO_SELECTION, "run", executeCompiledCommand) as TerminalCallResult<P, CommandResult, QueryError, "run", Args>
  }
}

// --- DELETE ------------------------------------------------------------------

class DeleteBuilder<T extends AnyTable, P extends NamedParams = {}> {
  private whereNode?: ExprNode

  /**
   * @param table - Target table.
   * @param whereNode - Optional predicate retained by an immutable clone.
   */
  constructor(private readonly table: T, whereNode?: ExprNode) {
    if (whereNode !== undefined) this.whereNode = whereNode
  }

  /**
   * @param predicate - Predicate replacing the current `WHERE` clause.
   * @returns This delete builder.
   */
  where<E extends ExprNode>(predicate: E): DeleteBuilder<T, MergeParams<P, ParamsOf<E>>> {
    return new DeleteBuilder<T, MergeParams<P, ParamsOf<E>>>(this.table, predicate)
  }

  /**
   * @param returning - Optional returned-field metadata.
   * @returns Delete runtime representation.
   */
  private ir(returning?: SelectionField[]): Exclude<QueryIR, SelectIR> {
    const meta = tableMeta(this.table)
    return {
      _tag: "Delete",
      id: nextId("Delete"),
      from: { name: meta.name },
      ...(this.whereNode ? { where: this.whereNode } : {}),
      ...(returning ? { returning } : {}),
      capabilities: returning ? capabilityBit("delete.returning") : noCapabilities,
      cardinality: "many",
      annotations: { tableNames: [meta.name], idempotency: "idempotent" }
    }
  }

  /** @returns Stable delete-shape metadata without executing. */
  inspect() {
    return inspectIr(this.ir())
  }

  /**
   * @param dialect - Target SQL dialect; defaults to PostgreSQL.
   * @returns Compiled delete SQL and parameter metadata.
   */
  toSql(dialect: Dialect = PostgresDialect): CompiledStatement {
    return dialect.compileQuery(this.ir())
  }

  /** @returns Capabilities required by this delete. */
  requiredCapabilities(): ReadonlyArray<Capability> {
    return bitsToCapabilities(queryCapabilityBits(this.ir()))
  }

  /**
   * @param fields - Optional fields to return; omit for all columns.
   * @returns A row-returning delete query.
   */
  returning<F extends SelectFields>(fields?: F): ReturningQuery<F extends SelectFields ? SelectResult<F> : Record<string, unknown>, P> {
    const selection = returningFields(this.table, fields)
    return new ReturningQuery(this.ir(selection), selection)
  }

  /**
   * @typeParam Args - Omitted for compilation or no-param execution; otherwise named values.
   * @param args - Named parameter values.
   * @returns An Effect yielding the affected-row count.
   */
  run<Args extends TerminalArguments<P>>(...args: Args & ExactTerminalArguments<P, Args>): TerminalCallResult<P, CommandResult, QueryError, "run", Args> {
    const ir = this.ir()
    const effect = Effect.flatMap(Database, (db) => executeCommand(ir, db, argsFrom(args)))
    return compilableEffect(effect, ir, NO_SELECTION, "run", executeCompiledCommand) as TerminalCallResult<P, CommandResult, QueryError, "run", Args>
  }
}

// --- entrypoint --------------------------------------------------------------

/** Pure query-builder entry point. No method touches a database until a terminal Effect is run. */
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

export type { SelectQuery, ReturningQuery }
