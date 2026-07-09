import fc from "fast-check"
import { Schema } from "effect"
import {
  and,
  db,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  like,
  lt,
  lte,
  ne,
  not,
  or,
  param,
  pg,
  type ExprNode,
  type QueryIR,
  type SelectIR,
  type SelectionField
} from "@gilvandovieira/thor"
import { noCapabilities } from "@gilvandovieira/thor/capabilities"
import { columnRef } from "@gilvandovieira/thor/sql"
import { tableMeta } from "@gilvandovieira/thor/schema"

export const fuzzRows = pg.table("property_rows", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull(),
  score: pg.integer("score").nullable(),
  active: pg.boolean("active").notNull()
})

type NumericOperator = "=" | "<>" | "<" | "<=" | ">" | ">="

export type PredicateLeaf =
  | { readonly kind: "numeric"; readonly op: NumericOperator; readonly value: number }
  | { readonly kind: "text"; readonly op: "=" | "<>" | "like" | "ilike"; readonly value: string }
  | { readonly kind: "named"; readonly name: string }
  | { readonly kind: "in"; readonly values: ReadonlyArray<number> }
  | { readonly kind: "null" }
  | { readonly kind: "volatile"; readonly id: number }

export interface PredicateCase {
  readonly leaves: ReadonlyArray<PredicateLeaf>
  readonly connectors: ReadonlyArray<"and" | "or">
  readonly negated: ReadonlyArray<boolean>
}

const identifierArbitrary = fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/)
const numberArbitrary = fc.integer({ min: -10_000, max: 10_000 })
const textArbitrary = fc.string({ maxLength: 24 })

export const predicateLeafArbitrary: fc.Arbitrary<PredicateLeaf> = fc.oneof(
  fc.record({
    kind: fc.constant("numeric" as const),
    op: fc.constantFrom<NumericOperator>("=", "<>", "<", "<=", ">", ">="),
    value: numberArbitrary
  }),
  fc.record({
    kind: fc.constant("text" as const),
    op: fc.constantFrom("=" as const, "<>" as const, "like" as const, "ilike" as const),
    value: textArbitrary
  }),
  fc.record({ kind: fc.constant("named" as const), name: identifierArbitrary }),
  fc.record({
    kind: fc.constant("in" as const),
    values: fc.array(numberArbitrary, { minLength: 1, maxLength: 5 })
  }),
  fc.record({ kind: fc.constant("null" as const) }),
  fc.record({ kind: fc.constant("volatile" as const), id: fc.nat({ max: 1_000_000 }) })
)

export const predicateCaseArbitrary: fc.Arbitrary<PredicateCase> = fc.record({
  leaves: fc.array(predicateLeafArbitrary, { minLength: 1, maxLength: 10 }),
  connectors: fc.array(fc.constantFrom("and" as const, "or" as const), { minLength: 1, maxLength: 10 }),
  negated: fc.array(fc.boolean(), { minLength: 1, maxLength: 10 })
})

/**
 * Builds one generated leaf expression.
 *
 * @param leaf - Predicate recipe leaf.
 * @returns Runtime predicate IR.
 */
const buildLeaf = (leaf: PredicateLeaf): ExprNode => {
  switch (leaf.kind) {
    case "numeric":
      switch (leaf.op) {
        case "=": return eq(fuzzRows.score, leaf.value)
        case "<>": return ne(fuzzRows.score, leaf.value)
        case "<": return lt(fuzzRows.score, leaf.value)
        case "<=": return lte(fuzzRows.score, leaf.value)
        case ">": return gt(fuzzRows.score, leaf.value)
        case ">=": return gte(fuzzRows.score, leaf.value)
      }
    case "text":
      switch (leaf.op) {
        case "=": return eq(fuzzRows.email, leaf.value)
        case "<>": return ne(fuzzRows.email, leaf.value)
        case "like": return like(fuzzRows.email, leaf.value)
        case "ilike": return ilike(fuzzRows.email, leaf.value)
      }
    case "named":
      return eq(fuzzRows.score, param(leaf.name, Schema.Number))
    case "in":
      return inArray(fuzzRows.score, leaf.values)
    case "null":
      return isNull(fuzzRows.score)
    case "volatile":
      return { _tag: "RawExpr", sql: `volatile_${leaf.id}()`, params: [] }
  }
}

/**
 * Builds a nested predicate while preserving generated leaf encounter order.
 *
 * @param recipe - Leaves, connectors, and optional negations.
 * @returns Nested runtime predicate IR.
 */
export const buildPredicate = (recipe: PredicateCase): ExprNode => {
  let expression = buildLeaf(recipe.leaves[0]!)
  for (let index = 1; index < recipe.leaves.length; index++) {
    const next = buildLeaf(recipe.leaves[index]!)
    const connector = recipe.connectors[(index - 1) % recipe.connectors.length]!
    expression = connector === "and" ? and(expression, next) : or(expression, next)
    if (recipe.negated[(index - 1) % recipe.negated.length]) expression = not(expression)
  }
  return expression
}

interface SelectRecipe {
  readonly predicate: PredicateCase
  readonly aggregate: boolean
  readonly orders: ReadonlyArray<{ readonly column: "email" | "score"; readonly direction: "asc" | "desc" }>
  readonly limit: number | undefined
  readonly offset: number | undefined
}

const selectRecipeArbitrary: fc.Arbitrary<SelectRecipe> = fc.record({
  predicate: predicateCaseArbitrary,
  aggregate: fc.boolean(),
  orders: fc.array(
    fc.record({
      column: fc.constantFrom("email" as const, "score" as const),
      direction: fc.constantFrom("asc" as const, "desc" as const)
    }),
    { maxLength: 4 }
  ),
  limit: fc.option(fc.integer({ min: 0, max: 100 }), { nil: undefined }),
  offset: fc.option(fc.integer({ min: 0, max: 100 }), { nil: undefined })
})

export const selectIrArbitrary: fc.Arbitrary<SelectIR> = selectRecipeArbitrary.map((recipe) => {
  const meta = tableMeta(fuzzRows)
  const selection: ReadonlyArray<SelectionField> = recipe.aggregate
    ? [{
        alias: "total",
        expr: { _tag: "RawExpr", sql: "count(*)", params: [] },
        codec: Schema.Number
      }]
    : [
        { alias: "email", expr: columnRef(fuzzRows.email), codec: fuzzRows.email.def.codec },
        { alias: "score", expr: columnRef(fuzzRows.score), codec: fuzzRows.score.def.codec }
      ]

  return {
    _tag: "Select",
    id: "property-select",
    from: { name: meta.name },
    selection,
    where: buildPredicate(recipe.predicate),
    orderBy: recipe.orders.map((order) => ({
      expr: columnRef(order.column === "email" ? fuzzRows.email : fuzzRows.score),
      direction: order.direction
    })),
    ...(recipe.limit !== undefined ? { limit: recipe.limit } : {}),
    ...(recipe.offset !== undefined ? { offset: recipe.offset } : {}),
    capabilities: noCapabilities,
    cardinality: recipe.limit === 1 ? "one" : "many",
    annotations: { tableNames: [meta.name] }
  }
})

const insertIrArbitrary: fc.Arbitrary<QueryIR> = fc
  .array(
    fc.record({ email: textArbitrary, score: numberArbitrary, active: fc.boolean() }),
    { minLength: 1, maxLength: 5 }
  )
  .map((rows) => db.insert(fuzzRows).values(rows).returning({ id: fuzzRows.id }).ir)

const updateIrArbitrary: fc.Arbitrary<QueryIR> = fc
  .tuple(numberArbitrary, predicateCaseArbitrary)
  .map(([score, predicate]) =>
    db
      .update(fuzzRows)
      .set({ score })
      .where(buildPredicate(predicate))
      .returning({ id: fuzzRows.id })
      .ir
  )

const deleteIrArbitrary: fc.Arbitrary<QueryIR> = predicateCaseArbitrary.map((predicate) =>
  db.delete(fuzzRows).where(buildPredicate(predicate)).returning({ id: fuzzRows.id }).ir
)

/** Query IR generator spanning nested selects and every current mutation kind. */
export const queryIrArbitrary: fc.Arbitrary<QueryIR> = fc.oneof(
  selectIrArbitrary,
  insertIrArbitrary,
  updateIrArbitrary,
  deleteIrArbitrary
)
