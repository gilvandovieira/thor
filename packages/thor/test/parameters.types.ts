import { Effect, Schema } from "effect"
import { db, eq, param, pg, rowNumber, sql } from "../src/index.js"
import { defineMigration, rawSql, type MigrationOperation } from "../src/migrate/index.js"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey(),
  email: pg.text("email").notNull()
})
const posts = pg.table("posts", {
  id: pg.uuid("id").primaryKey(),
  userId: pg.uuid("user_id").notNull(),
  title: pg.text("title").notNull()
})

const byId = db
  .select({ email: users.email })
  .from(users)
  .where(eq(users.id, param("id", Schema.String)))
const compiledById = byId.one().compile()
compiledById.execute({ id: "u1" })
// @ts-expect-error compiled execution requires the named parameter
compiledById.execute()
// @ts-expect-error compiled execution retains the parameter schema
compiledById.execute({ id: 1 })
// @ts-expect-error compiled execution rejects extra named parameters
compiledById.execute({ id: "u1", extra: true })
type CompiledByIdOutput = Effect.Effect.Success<ReturnType<typeof compiledById.execute>>
export type CompiledQueryRetainsOutput = Expect<Equal<CompiledByIdOutput, { email: string }>>
export type CompiledQueryRetainsCardinality = Expect<Equal<typeof compiledById.cardinality, "one">>
const idParam = param("id", Schema.String)
export type ParamCarriesString = Expect<
  Equal<import("../src/sql/expressions.js").ParamsOf<typeof idParam>, { readonly id: string }>
>
const idPredicate = eq(users.id, idParam)
export type PredicateCarriesString = Expect<
  Equal<import("../src/sql/expressions.js").ParamsOf<typeof idPredicate>, { readonly id: string }>
>
byId.all({ id: "u1" })
const byIdTerminal = byId.all()
byIdTerminal.compile()
// @ts-expect-error a parameterized no-argument terminal is compile-only, not executable
Effect.runPromise(byIdTerminal)
// @ts-expect-error named argument types come from param()'s schema
byId.all({ id: 1 })
// @ts-expect-error extra named arguments are rejected
byId.all({ id: "u1", extra: true })

const create = db.insert(users).values({
  id: param("id", Schema.String),
  email: param("email", Schema.String)
})
create.run({ id: "u1", email: "a@example.com" })
// @ts-expect-error mutation parameters are threaded into terminal methods
create.run({ id: "u1" })

const left = db
  .select({ email: users.email, title: posts.title })
  .from(users)
  .leftJoin(posts, eq(users.id, posts.userId))
type LeftRows = Effect.Effect.Success<ReturnType<typeof left.all>>
export type LeftJoinIsNullable = Expect<Equal<LeftRows, ReadonlyArray<{ email: string; title: string | null }>>>

const right = db
  .select({ email: users.email, title: posts.title })
  .from(users)
  .rightJoin(posts, eq(users.id, posts.userId))
type RightRows = Effect.Effect.Success<ReturnType<typeof right.all>>
export type RightJoinIsNullable = Expect<Equal<RightRows, ReadonlyArray<{ email: string | null; title: string }>>>

const full = db
  .select({ email: users.email, title: posts.title })
  .from(users)
  .fullJoin(posts, eq(users.id, posts.userId))
type FullRows = Effect.Effect.Success<ReturnType<typeof full.all>>
export type FullJoinIsNullable = Expect<Equal<FullRows, ReadonlyArray<{ email: string | null; title: string | null }>>>

defineMigration({ id: "0001_backfill", name: "backfill", revision: "1", up: rawSql`select 1` })
// @ts-expect-error Effect migration steps require an explicit revision fingerprint
defineMigration({ id: "0001_backfill", name: "backfill", up: rawSql`select 1` })
// @ts-expect-error raw query strings cannot interpolate ordinary runtime values
sql`${"untrusted"}`
// @ts-expect-error migration SQL cannot interpolate ordinary runtime values
rawSql`select ${"untrusted"}`
// @ts-expect-error custom window-frame SQL requires unsafeSql(...); use rowsBetween(...) for structured frames
rowNumber().over({ frame: "rows between unbounded preceding and current row" })
const invalidRoutineSql: MigrationOperation = {
  _tag: "CreateRoutine",
  routine: "function",
  name: "unsafe_body",
  args: [],
  // @ts-expect-error routine language syntax requires an explicit unsafeSql boundary
  language: "sql",
  // @ts-expect-error routine body syntax requires an explicit unsafeSql boundary
  body: "select 1",
  destructive: false,
  reversible: true,
  capabilities: []
}
void invalidRoutineSql
// @ts-expect-error generated SQL expressions require unsafeSql(...)
pg.integer("generated").generatedAlwaysAs("value + 1")
// @ts-expect-error SQL defaults require unsafeSql(...)
pg.integer("defaulted").defaultSql("42")
pg.table(
  "unsafe_checks",
  { id: pg.integer("id") },
  {
    // @ts-expect-error check-constraint SQL requires unsafeSql(...)
    checks: [{ expression: "id > 0" }]
  }
)
