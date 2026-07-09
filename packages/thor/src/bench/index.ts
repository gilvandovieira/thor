/**
 * Benchmark entrypoint (spec §15.4). Run with `pnpm --filter @gilvandovieira/thor run bench`.
 *
 * @module bench
 */
import { db } from "../sql/query-builder.js"
import { eq } from "../sql/predicates.js"
import { param } from "../sql/expressions.js"
import { count } from "../sql/advanced-expressions.js"
import { PostgresDialect } from "../postgres/dialect.js"
import { Schema } from "effect"
import { bench, formatResult } from "./runner.js"
import { users } from "./fixtures.js"
import { defineFunction } from "../routine/index.js"

const emailParam = param("email", Schema.String)
const lowerRoutine = defineFunction("lower", {
  args: [{ dataType: "text", codec: Schema.String }],
  returns: { dataType: "text", codec: Schema.String },
  volatility: "immutable"
})

const results = [
  bench("build:select-where", () => {
    db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, emailParam)).limit(1)
  }),
  bench("compile:select-where", () => {
    db.select({ id: users.id, email: users.email }).from(users).where(eq(users.email, emailParam)).toSql(PostgresDialect)
  }),
  bench("build:insert", () => {
    db.insert(users).values({ email: "a@b.c", name: "A" }).returning({ id: users.id })
  }),
  bench("build:aggregate", () => {
    db.select({ email: users.email, total: count() }).from(users).groupBy(users.email)
  }),
  bench("compile:aggregate", () => {
    db.select({ email: users.email, total: count() }).from(users).groupBy(users.email).toSql(PostgresDialect)
  }),
  bench("build:routine", () => {
    db.select({ lowered: lowerRoutine(users.email) }).from(users)
  }),
  bench("compile:routine", () => {
    db.select({ lowered: lowerRoutine(users.email) }).from(users).toSql(PostgresDialect)
  })
]

// eslint-disable-next-line no-console
console.log("\nThor micro-benchmarks (Postgres)\n" + "-".repeat(60))
for (const r of results) console.log(formatResult(r))
console.log()
