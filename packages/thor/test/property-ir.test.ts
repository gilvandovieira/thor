import fc from "fast-check"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  CapabilityError,
  Database,
  MySQLDialect,
  PostgresDialect,
  SQLiteDialect,
  and,
  collectQueryParams,
  db,
  normalizeQuery,
  or,
  queryStructuralHash,
  withMode,
  type DeleteIR,
  type ExecutionMode,
  type ExprNode,
  type InsertIR,
  type ParamNode,
  type QueryIR,
  type SelectIR,
  type SelectionField,
  type UpdateIR
} from "@gilvandovieira/thor"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"
import {
  buildPredicate,
  fuzzRows,
  predicateCaseArbitrary,
  queryIrArbitrary,
  selectIrArbitrary
} from "./property/arbitraries.js"

const DEFAULT_SEED = 0x54484f52
const configuredSeed = Number(process.env.FC_SEED ?? DEFAULT_SEED)
const configuredRuns = Number(process.env.FC_NUM_RUNS ?? 100)

/**
 * Builds deterministic fast-check settings with a distinct seed per property.
 *
 * @param offset - Stable offset assigned to one property.
 * @param numRuns - Optional smaller run count for asynchronous properties.
 * @returns Reproducible fast-check assertion parameters.
 */
const propertyParameters = (offset: number, numRuns = configuredRuns): fc.Parameters<unknown> => ({
  seed: configuredSeed + offset,
  numRuns,
  endOnFailure: true
})

const dialects = [PostgresDialect, SQLiteDialect, MySQLDialect] as const

/**
 * Redacts a parameter to its ordering-relevant identity.
 *
 * @param node - Parameter IR node.
 * @returns Stable marker that excludes bound data.
 */
const parameterIdentity = (node: ParamNode): string =>
  "value" in node ? "<bound>" : `<named:${node.name}>`

/**
 * Replaces inline parameter values without changing query structure.
 *
 * @param value - Existing bound value.
 * @param salt - Generated replacement salt.
 * @returns A different value of the same broad runtime kind.
 */
const replaceValue = (value: unknown, salt: number): unknown => {
  if (typeof value === "number") return value + salt + 1
  if (typeof value === "string") return `${value}:${salt}`
  if (typeof value === "boolean") return !value
  if (value instanceof Date) return new Date(value.getTime() + salt + 1)
  return { original: value, salt }
}

/**
 * Rewrites every inline parameter in an expression tree.
 *
 * @param node - Expression to copy.
 * @param salt - Generated replacement salt.
 * @returns Structurally equal expression with different bound values.
 */
const rewriteExpressionValues = (node: ExprNode, salt: number): ExprNode => {
  switch (node._tag) {
    case "ColumnRef":
    case "Literal":
    case "ExcludedRef":
      return node
    case "Param":
      return "value" in node ? { ...node, value: replaceValue(node.value, salt) } : node
    case "Comparison":
      return {
        ...node,
        left: rewriteExpressionValues(node.left, salt),
        right: rewriteExpressionValues(node.right, salt)
      }
    case "InList":
      return {
        ...node,
        expr: rewriteExpressionValues(node.expr, salt),
        values: node.values.map((value) => rewriteExpressionValues(value, salt))
      }
    case "Logical":
      return {
        ...node,
        operands: node.operands.map((operand) => rewriteExpressionValues(operand, salt))
      }
    case "Not":
    case "IsNull":
      return { ...node, expr: rewriteExpressionValues(node.expr, salt) }
    case "RawExpr":
      return {
        ...node,
        values: node.values.map((value) =>
          value._tag === "Param"
            ? rewriteExpressionValues(value, salt) as ParamNode
            : value
        )
      }
    case "ScalarSubquery":
    case "Exists":
      return { ...node, query: rewriteQueryValues(node.query, salt) as SelectIR }
    case "InSubquery":
      return {
        ...node,
        expr: rewriteExpressionValues(node.expr, salt),
        query: rewriteQueryValues(node.query, salt) as SelectIR
      }
    case "FunctionCall":
      return { ...node, args: node.args.map((arg) => rewriteExpressionValues(arg, salt)) }
    case "WindowFunction":
      return {
        ...node,
        function: rewriteExpressionValues(node.function, salt) as typeof node.function,
        partitionBy: node.partitionBy.map((item) => rewriteExpressionValues(item, salt)),
        orderBy: node.orderBy.map((term) => ({
          ...term,
          expr: rewriteExpressionValues(term.expr, salt)
        }))
      }
  }
}

/**
 * @param fields - Optional selection to rewrite.
 * @param salt - Generated replacement salt.
 * @returns Copied selection with rewritten expressions.
 */
const rewriteSelectionValues = (
  fields: ReadonlyArray<SelectionField> | undefined,
  salt: number
): ReadonlyArray<SelectionField> | undefined =>
  fields?.map((field) => ({ ...field, expr: rewriteExpressionValues(field.expr, salt) }))

/**
 * Copies a query while replacing every inline value.
 *
 * @param ir - Query IR to copy.
 * @param salt - Generated replacement salt.
 * @returns Structurally equivalent query IR.
 */
const rewriteQueryValues = (ir: QueryIR, salt: number): QueryIR => {
  switch (ir._tag) {
    case "Select":
      return {
        ...ir,
        from: "_tag" in ir.from && ir.from._tag === "SubquerySource"
          ? { ...ir.from, query: rewriteQueryValues(ir.from.query, salt) as SelectIR }
          : ir.from,
        selection: rewriteSelectionValues(ir.selection, salt)!,
        ...(ir.ctes ? {
          ctes: ir.ctes.map((cte) => ({
            ...cte,
            query: rewriteQueryValues(cte.query, salt) as SelectIR
          }))
        } : {}),
        ...(ir.joins ? {
          joins: ir.joins.map((join) => ({
            ...join,
            source: "_tag" in join.source && join.source._tag === "SubquerySource"
              ? { ...join.source, query: rewriteQueryValues(join.source.query, salt) as SelectIR }
              : join.source,
            ...(join.on ? { on: rewriteExpressionValues(join.on, salt) } : {})
          }))
        } : {}),
        ...(ir.where ? { where: rewriteExpressionValues(ir.where, salt) } : {}),
        ...(ir.groupBy ? { groupBy: ir.groupBy.map((item) => rewriteExpressionValues(item, salt)) } : {}),
        ...(ir.having ? { having: rewriteExpressionValues(ir.having, salt) } : {}),
        ...(ir.setOperations ? {
          setOperations: ir.setOperations.map((operation) => ({
            ...operation,
            query: rewriteQueryValues(operation.query, salt) as SelectIR
          }))
        } : {}),
        orderBy: ir.orderBy.map((term) => ({
          ...term,
          expr: rewriteExpressionValues(term.expr, salt)
        }))
      } satisfies SelectIR
    case "Insert":
      return {
        ...ir,
        rows: ir.rows.map((row) => row.map((value) => rewriteExpressionValues(value, salt))),
        ...(ir.conflict ? {
          conflict: {
            ...ir.conflict,
            set: ir.conflict.set.map((assignment) => ({
              ...assignment,
              value: rewriteExpressionValues(assignment.value, salt)
            }))
          }
        } : {}),
        ...(ir.returning ? { returning: rewriteSelectionValues(ir.returning, salt)! } : {})
      } satisfies InsertIR
    case "Update":
      return {
        ...ir,
        set: ir.set.map((term) => ({
          ...term,
          value: rewriteExpressionValues(term.value, salt)
        })),
        ...(ir.where ? { where: rewriteExpressionValues(ir.where, salt) } : {}),
        ...(ir.returning ? { returning: rewriteSelectionValues(ir.returning, salt)! } : {})
      } satisfies UpdateIR
    case "Delete":
      return {
        ...ir,
        ...(ir.where ? { where: rewriteExpressionValues(ir.where, salt) } : {}),
        ...(ir.returning ? { returning: rewriteSelectionValues(ir.returning, salt)! } : {})
      } satisfies DeleteIR
  }
}

/**
 * Counts and validates dialect placeholders against the compiled parameter list.
 *
 * @param dialectId - Active dialect identifier.
 * @param sql - Compiled SQL text.
 * @param expected - Expected number of parameters.
 * @returns Nothing; assertions throw on mismatch.
 */
const expectBoundPlaceholders = (dialectId: string, sql: string, expected: number): void => {
  if (dialectId === "postgres") {
    const positions = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))
    expect(positions).toEqual(Array.from({ length: expected }, (_, index) => index + 1))
    return
  }
  expect(sql.match(/\?/g)?.length ?? 0).toBe(expected)
}

describe("Epic H property and fuzz invariants", () => {
  it("normalization is idempotent by value and identity", () => {
    fc.assert(
      fc.property(queryIrArbitrary, (ir) => {
        const once = normalizeQuery(ir)
        const twice = normalizeQuery(once)

        expect(twice).toBe(once)
        expect(twice).toEqual(once)
        expect(queryStructuralHash(twice)).toBe(queryStructuralHash(once))
      }),
      propertyParameters(1)
    )
  })

  it("compiles every parameter exactly once in deterministic encounter order", () => {
    fc.assert(
      fc.property(queryIrArbitrary, (ir) => {
        const normalized = normalizeQuery(ir)
        const expectedOrder = collectQueryParams(normalized).map(parameterIdentity)

        for (const dialect of dialects) {
          const first = dialect.compileQuery(normalized)
          const second = dialect.compileQuery(normalized)

          expect(first.sql).toBe(second.sql)
          expect(first.cacheKey).toBe(second.cacheKey)
          expect(first.paramOrder.map(parameterIdentity)).toEqual(expectedOrder)
          expect(second.paramOrder.map(parameterIdentity)).toEqual(expectedOrder)
          expectBoundPlaceholders(dialect.id, first.sql, expectedOrder.length)
        }
      }),
      propertyParameters(2)
    )
  })

  it("keeps structural hashes and compiled cache keys independent of bound values", () => {
    fc.assert(
      fc.property(queryIrArbitrary, fc.integer(), (ir, salt) => {
        const changedValues = rewriteQueryValues(ir, salt)

        expect(queryStructuralHash(changedValues)).toBe(queryStructuralHash(ir))
        for (const dialect of dialects) {
          const original = dialect.compileQuery(ir)
          const changed = dialect.compileQuery(changedValues)
          expect(changed.sql).toBe(original.sql)
          expect(changed.cacheKey).toBe(original.cacheKey)
        }
      }),
      propertyParameters(3)
    )
  })

  it("changes structural and compiled keys when SQL shape meaningfully changes", () => {
    fc.assert(
      fc.property(selectIrArbitrary, (ir) => {
        const changed: SelectIR = {
          ...ir,
          limit: (ir.limit ?? 0) + 1,
          cardinality: "many"
        }

        expect(queryStructuralHash(changed)).not.toBe(queryStructuralHash(ir))
        for (const dialect of dialects) {
          expect(dialect.compileQuery(changed).cacheKey).not.toBe(dialect.compileQuery(ir).cacheKey)
        }
      }),
      propertyParameters(4)
    )
  })

  it("normalization preserves required capability bits", () => {
    fc.assert(
      fc.property(queryIrArbitrary, (ir) => {
        const normalized = normalizeQuery(ir)
        expect(normalized.capabilities).toBe(ir.capabilities)
      }),
      propertyParameters(5)
    )
  })

  it("rejects unsupported returning before the driver in every execution mode", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("insert" as const, "update" as const, "delete" as const),
        fc.constantFrom<ExecutionMode>("safe", "trusted", "unsafe"),
        fc.string({ maxLength: 24 }),
        fc.integer(),
        async (operation, mode, email, score) => {
          const driver = new FakeDriver()
          const layer = withMode(FakeDatabaseLayer(driver, { dialect: MySQLDialect }), mode)
          const query = operation === "insert"
            ? db.insert(fuzzRows).values({ email, score, active: true }).returning({ id: fuzzRows.id }).run()
            : operation === "update"
              ? db.update(fuzzRows).set({ score }).returning({ id: fuzzRows.id }).run()
              : db.delete(fuzzRows).returning({ id: fuzzRows.id }).run()
          const error = await Effect.runPromise(
            Effect.provide(Effect.flip(query), layer) as Effect.Effect<unknown, never, never>
          )

          expect(error).toBeInstanceOf(CapabilityError)
          expect(driver.calls).toEqual([])
        }
      ),
      propertyParameters(6, Math.min(configuredRuns, 50))
    )
  })

  it("never reorders volatile calls while flattening nested predicates", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.nat({ max: 1_000_000 }), { minLength: 2, maxLength: 12 }),
        fc.array(fc.constantFrom("and" as const, "or" as const), { minLength: 1, maxLength: 12 }),
        (ids, connectors) => {
          let predicate: ExprNode = { _tag: "RawExpr", strings: [`volatile_${ids[0]}()`], values: [] }
          for (let index = 1; index < ids.length; index++) {
            const next: ExprNode = {
              _tag: "RawExpr",
              strings: [`volatile_${ids[index]}()`],
              values: []
            }
            predicate = connectors[(index - 1) % connectors.length] === "and"
              ? and(predicate, next)
              : or(predicate, next)
          }

          const ir = db.select({ id: fuzzRows.id }).from(fuzzRows).where(predicate).ir
          for (const dialect of dialects) {
            const sql = dialect.compileQuery(ir).sql
            const offsets = ids.map((id) => sql.indexOf(`volatile_${id}()`))
            expect(offsets.every((offset) => offset >= 0)).toBe(true)
            expect(offsets).toEqual([...offsets].sort((left, right) => left - right))
          }
        }
      ),
      propertyParameters(7)
    )
  })

  it("normalizes generated mixed predicate trees without changing leaf order", () => {
    fc.assert(
      fc.property(predicateCaseArbitrary, (recipe) => {
        const predicate = buildPredicate(recipe)
        const ir = db.select({ id: fuzzRows.id }).from(fuzzRows).where(predicate).ir
        const before = collectQueryParams(ir).map(parameterIdentity)
        const after = collectQueryParams(normalizeQuery(ir)).map(parameterIdentity)

        expect(after).toEqual(before)
      }),
      propertyParameters(8)
    )
  })
})
