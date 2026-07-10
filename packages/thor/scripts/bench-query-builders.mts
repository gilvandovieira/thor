/**
 * Public-API query construction benchmark: Thor, Drizzle ORM, and Prisma ORM.
 *
 * This measures two public-API phases without a database:
 *   - build: construct the typed query builder,
 *   - build + SQL: construct it and generate PostgreSQL SQL + parameters
 *     (Thor and Drizzle only; Prisma has no public offline `toSQL()` API).
 *
 * Run from the repository root with `pnpm bench:builders`.
 */
import { readFileSync } from "node:fs"
import { performance } from "node:perf_hooks"
import { Schema } from "effect"
import { count as thorCount, db as thorDb, eq as thorEq, param, pg } from "@gilvandovieira/thor"
import { PostgresDialect } from "@gilvandovieira/thor/postgres"
import { PrismaPg } from "@prisma/adapter-pg"
import { count as drizzleCount, eq as drizzleEq, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { integer, pgTable, text, uuid } from "drizzle-orm/pg-core"
import { PrismaClient } from "../.generated/prisma/client.ts"

const samples = Number(process.env.BENCH_SAMPLES ?? 5)
const iterations = Number(process.env.BENCH_ITERATIONS ?? 20_000)
if (!Number.isInteger(samples) || samples < 3) throw new Error("BENCH_SAMPLES must be an integer of at least 3")
if (!Number.isInteger(iterations) || iterations < 1_000) throw new Error("BENCH_ITERATIONS must be an integer of at least 1,000")

interface Timing {
  readonly nsPerOp: number
  readonly fastestNsPerOp: number
  readonly slowestNsPerOp: number
}

interface Comparison {
  readonly workload: string
  readonly phase: "build" | "build + SQL"
  readonly thor: Timing
  readonly drizzle: Timing
  readonly ratio: number
  readonly prisma?: Timing
  readonly thorPrismaRatio?: number
}

interface Workload {
  readonly name: string
  readonly explanation: string
  readonly thor: () => { toSql: (dialect: typeof PostgresDialect) => unknown }
  readonly drizzle: () => { toSQL: () => unknown }
  readonly prisma: () => unknown
}

let sink: unknown

const median = (sorted: ReadonlyArray<number>): number => {
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

const summarize = (values: ReadonlyArray<number>): Timing => {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    nsPerOp: median(sorted),
    fastestNsPerOp: sorted[0]!,
    slowestNsPerOp: sorted[sorted.length - 1]!
  }
}

const time = (fn: () => unknown): number => {
  const start = performance.now()
  for (let i = 0; i < iterations; i++) sink = fn()
  return ((performance.now() - start) * 1e6) / iterations
}

const compare = (
  workload: string,
  phase: Comparison["phase"],
  thor: () => unknown,
  drizzleQuery: () => unknown,
  prismaQuery?: () => unknown
): Comparison => {
  for (let i = 0; i < 5_000; i++) {
    sink = thor()
    sink = drizzleQuery()
    if (prismaQuery) sink = prismaQuery()
  }

  const thorSamples: number[] = []
  const drizzleSamples: number[] = []
  const prismaSamples: number[] = []
  const implementations = [
    { name: "thor", fn: thor, values: thorSamples },
    { name: "drizzle", fn: drizzleQuery, values: drizzleSamples },
    ...(prismaQuery ? [{ name: "prisma", fn: prismaQuery, values: prismaSamples }] : [])
  ]
  for (let sample = 0; sample < samples; sample++) {
    // Rotating the order reduces bias from CPU temperature and background work.
    for (let offset = 0; offset < implementations.length; offset++) {
      const implementation = implementations[(sample + offset) % implementations.length]!
      implementation.values.push(time(implementation.fn))
    }
  }

  const thorTiming = summarize(thorSamples)
  const drizzleTiming = summarize(drizzleSamples)
  const base = {
    workload,
    phase,
    thor: thorTiming,
    drizzle: drizzleTiming,
    ratio: thorTiming.nsPerOp / drizzleTiming.nsPerOp
  }
  if (!prismaQuery) return base
  const prismaTiming = summarize(prismaSamples)
  return {
    ...base,
    prisma: prismaTiming,
    thorPrismaRatio: thorTiming.nsPerOp / prismaTiming.nsPerOp
  }
}

const formatDuration = (ns: number): string => {
  if (ns < 1_000) return `${ns.toFixed(0)} ns`
  return `${(ns / 1_000).toFixed(ns < 10_000 ? 2 : 1)} µs`
}

const formatRange = (timing: Timing): string =>
  `${formatDuration(timing.fastestNsPerOp)}–${formatDuration(timing.slowestNsPerOp)}`

const plainReading = (ratio: number): string => {
  if (ratio >= 0.8 && ratio <= 1.25) return "about even"
  if (ratio < 0.5) return `Thor ~${(1 / ratio).toFixed(1)}× faster`
  if (ratio < 0.8) return "same ballpark; Thor ahead"
  if (ratio <= 2) return "same ballpark; Drizzle ahead"
  return `Drizzle ~${ratio.toFixed(1)}× faster`
}

const geometricMean = (values: ReadonlyArray<number>): number =>
  Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length)

const thorUsers = pg.table("bench_users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull().unique(),
  name: pg.text("name").nullable(),
  age: pg.integer("age").nullable()
})
const thorPosts = pg.table("bench_posts", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  userId: pg.uuid("user_id").notNull()
})
const emailParam = param("email", Schema.String)

const drizzleUsers = pgTable("bench_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  age: integer("age")
})
const drizzlePosts = pgTable("bench_posts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull()
})
const drizzleDb = drizzle.mock()
const drizzleEmail = sql.placeholder("email")
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: "postgresql://bench:bench@127.0.0.1:1/bench" })
})
const prismaEmail = "a@b.c"

const workloads: ReadonlyArray<Workload> = [
  {
    name: "point select",
    explanation: "two columns, named email parameter, limit one",
    thor: () =>
      thorDb
        .select({ id: thorUsers.id, email: thorUsers.email })
        .from(thorUsers)
        .where(thorEq(thorUsers.email, emailParam))
        .limit(1),
    drizzle: () =>
      drizzleDb
        .select({ id: drizzleUsers.id, email: drizzleUsers.email })
        .from(drizzleUsers)
        .where(drizzleEq(drizzleUsers.email, drizzleEmail))
        .limit(1),
    prisma: () =>
      prisma.benchUser.findFirst({
        select: { id: true, email: true },
        where: { email: prismaEmail },
        take: 1
      })
  },
  {
    name: "insert returning",
    explanation: "two values, return generated id",
    thor: () => thorDb.insert(thorUsers).values({ email: "a@b.c", name: "Ada" }).returning({ id: thorUsers.id }),
    drizzle: () => drizzleDb.insert(drizzleUsers).values({ email: "a@b.c", name: "Ada" }).returning({ id: drizzleUsers.id }),
    prisma: () =>
      prisma.benchUser.create({
        data: { email: prismaEmail, name: "Ada" },
        select: { id: true }
      })
  },
  {
    name: "grouped count",
    explanation: "group by email and count rows",
    thor: () => thorDb.select({ email: thorUsers.email, total: thorCount() }).from(thorUsers).groupBy(thorUsers.email),
    drizzle: () =>
      drizzleDb.select({ email: drizzleUsers.email, total: drizzleCount() }).from(drizzleUsers).groupBy(drizzleUsers.email),
    prisma: () => prisma.benchUser.groupBy({ by: ["email"], _count: { _all: true } })
  },
  {
    name: "users + posts",
    explanation: "left join for SQL builders; analogous nested relation selection for Prisma",
    thor: () =>
      thorDb
        .select({ email: thorUsers.email, postId: thorPosts.id })
        .from(thorUsers)
        .leftJoin(thorPosts, thorEq(thorUsers.id, thorPosts.userId)),
    drizzle: () =>
      drizzleDb
        .select({ email: drizzleUsers.email, postId: drizzlePosts.id })
        .from(drizzleUsers)
        .leftJoin(drizzlePosts, drizzleEq(drizzleUsers.id, drizzlePosts.userId)),
    prisma: () =>
      prisma.benchUser.findMany({
        select: { email: true, posts: { select: { id: true } } }
      })
  },
  {
    name: "update returning",
    explanation: "set one column by named email parameter, return id",
    thor: () =>
      thorDb
        .update(thorUsers)
        .set({ name: "Updated" })
        .where(thorEq(thorUsers.email, emailParam))
        .returning({ id: thorUsers.id }),
    drizzle: () =>
      drizzleDb
        .update(drizzleUsers)
        .set({ name: "Updated" })
        .where(drizzleEq(drizzleUsers.email, drizzleEmail))
        .returning({ id: drizzleUsers.id }),
    prisma: () =>
      prisma.benchUser.update({
        where: { email: prismaEmail },
        data: { name: "Updated" },
        select: { id: true }
      })
  }
]

// Compile one query of each shape before timing so unsupported or malformed
// workloads fail loudly instead of producing a persuasive but invalid table.
const sqlExamples = Object.fromEntries(
  workloads.map((workload) => {
    const thor = workload.thor().toSql(PostgresDialect) as { sql: string }
    const drizzleQuery = workload.drizzle().toSQL() as { sql: string }
    if (!thor.sql || !drizzleQuery.sql) throw new Error(`${workload.name} did not generate SQL in both toolkits`)
    return [workload.name, { thor: thor.sql, drizzle: drizzleQuery.sql }]
  })
)

const buildComparisons = workloads.map((workload) =>
  compare(workload.name, "build", workload.thor, workload.drizzle, workload.prisma)
)
const sqlComparisons = workloads.map((workload) =>
  compare(
    workload.name,
    "build + SQL",
    () => workload.thor().toSql(PostgresDialect),
    () => workload.drizzle().toSQL()
  )
)
const comparisons = [...buildComparisons, ...sqlComparisons]

const drizzlePackage = JSON.parse(
  readFileSync(new URL("../node_modules/drizzle-orm/package.json", import.meta.url), "utf8")
) as { version: string }
const prismaPackage = JSON.parse(
  readFileSync(new URL("../node_modules/@prisma/client/package.json", import.meta.url), "utf8")
) as { version: string }

console.log(
  `\nThor versus Drizzle ORM ${drizzlePackage.version} and Prisma ORM ${prismaPackage.version} — query construction, no database\n` +
    "-".repeat(142)
)
console.log(`Smaller is faster. Typical = median of ${samples} samples × ${iterations.toLocaleString("en-US")} operations; range = fastest–slowest.`)
console.log("All toolkits use their normal public API and equivalent query intent. Results measure CPU work, not database speed.\n")

console.log("Public query/request construction")
console.log("Prisma creates a lazy request here; its query engine and SQL generation do not run until the request is awaited.\n")
console.log(
  `  ${"workload".padEnd(20)} ${"Thor".padStart(10)} ${"Thor range".padStart(19)} ${"Drizzle".padStart(10)} ${"Drizzle range".padStart(19)} ${"Prisma".padStart(10)} ${"Prisma range".padStart(19)} ${"Thor/Drizzle".padStart(14)} ${"Thor/Prisma".padStart(13)}`
)
for (const result of buildComparisons) {
  console.log(
    `  ${result.workload.padEnd(20)} ${formatDuration(result.thor.nsPerOp).padStart(10)} ${formatRange(result.thor).padStart(19)} ${formatDuration(result.drizzle.nsPerOp).padStart(10)} ${formatRange(result.drizzle).padStart(19)} ${formatDuration(result.prisma!.nsPerOp).padStart(10)} ${formatRange(result.prisma!).padStart(19)} ${`${result.ratio.toFixed(2)}×`.padStart(14)} ${`${result.thorPrismaRatio!.toFixed(2)}×`.padStart(13)}`
  )
}

console.log("\nComplete query construction plus PostgreSQL SQL generation")
console.log("Prisma is N/A because its public client does not expose offline SQL generation.\n")
console.log(
  `  ${"workload".padEnd(20)} ${"Thor".padStart(10)} ${"Thor range".padStart(19)} ${"Drizzle".padStart(10)} ${"Drizzle range".padStart(19)} ${"Thor/Drizzle".padStart(14)}  reading`
)
for (const result of sqlComparisons) {
  console.log(
    `  ${result.workload.padEnd(20)} ${formatDuration(result.thor.nsPerOp).padStart(10)} ${formatRange(result.thor).padStart(19)} ${formatDuration(result.drizzle.nsPerOp).padStart(10)} ${formatRange(result.drizzle).padStart(19)} ${`${result.ratio.toFixed(2)}×`.padStart(14)}  ${plainReading(result.ratio)}`
  )
}

const buildDrizzleRatio = geometricMean(buildComparisons.map((result) => result.ratio))
const buildPrismaRatio = geometricMean(buildComparisons.map((result) => result.thorPrismaRatio!))
const sqlRatio = geometricMean(sqlComparisons.map((result) => result.ratio))

console.log("\nIn everyday terms:")
console.log(`  • Across these common shapes, Thor takes ${(buildDrizzleRatio * 100).toFixed(0)}% of Drizzle's builder-construction time.`)
console.log(`  • Thor takes ${(buildPrismaRatio * 100).toFixed(0)}% of Prisma's lazy request-construction time.`)
console.log(`  • When SQL generation is included, Thor takes ${(sqlRatio * 100).toFixed(0)}% of Drizzle's time.`)
console.log("  • No honest Prisma SQL-generation number is available without executing its engine against a database, so none is invented here.")
console.log("  • A difference measured in microseconds will usually be dwarfed by a real database round-trip; this benchmark targets toolkit overhead.")
console.log("  • Rerun before acting on a small difference, especially when the sample ranges overlap.\n")

if (process.env.BENCH_SHOW_SQL) console.log(`SQL:${JSON.stringify(sqlExamples)}`)
console.log(
  `JSON:${JSON.stringify({
    environment: { node: process.versions.node, drizzle: drizzlePackage.version, prisma: prismaPackage.version, samples, iterations },
    workloads: Object.fromEntries(workloads.map((workload) => [workload.name, workload.explanation])),
    comparisons
  })}`
)

await prisma.$disconnect()
void sink
