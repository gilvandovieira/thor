import { Effect, Schema } from "effect"
import { db, eq, param, pg, sql } from "../src/index.js"
import { defineMigration, rawSql } from "../src/migrate/index.js"

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
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

const byId = db.select({ email: users.email }).from(users).where(eq(users.id, param("id", Schema.String)))
const idParam = param("id", Schema.String)
export type ParamCarriesString = Expect<Equal<import("../src/sql/expressions.js").ParamsOf<typeof idParam>, { readonly id: string }>>
const idPredicate = eq(users.id, idParam)
export type PredicateCarriesString = Expect<Equal<import("../src/sql/expressions.js").ParamsOf<typeof idPredicate>, { readonly id: string }>>
byId.all({ id: "u1" })
// @ts-expect-error named arguments are required
byId.all()
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

const left = db.select({ email: users.email, title: posts.title }).from(users)
  .leftJoin(posts, eq(users.id, posts.userId))
type LeftRows = Effect.Effect.Success<ReturnType<typeof left.all>>
export type LeftJoinIsNullable = Expect<Equal<LeftRows, ReadonlyArray<{ email: string; title: string | null }>>>

const right = db.select({ email: users.email, title: posts.title }).from(users)
  .rightJoin(posts, eq(users.id, posts.userId))
type RightRows = Effect.Effect.Success<ReturnType<typeof right.all>>
export type RightJoinIsNullable = Expect<Equal<RightRows, ReadonlyArray<{ email: string | null; title: string }>>>

const full = db.select({ email: users.email, title: posts.title }).from(users)
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
