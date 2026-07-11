# Thor Project v1 Specification

> **✅ Current — authoritative specification.** This v1 spec supersedes the
> archived [v0 specification](./thor-project-spec-v0.md), which is retained only
> as the acceptance reference for the delivered Epics A–J foundation. See
> [`README.md`](./README.md) for the full docs index.

**Status:** Current — authoritative early-beta contract (supersedes the v0 spec)
**Project placeholder name:** Thor Project
**Package scope placeholder:** `@gilvandovieira`
**Primary package:** `@gilvandovieira/thor`
**CLI package:** `@gilvandovieira/cli`
**CLI binary:** `thor`
**Primary v1 goal:** Production-readiness work for the Effect-native ORM/database toolkit defined in the v0 specification. This document distinguishes shipped early-beta behavior from deferred stable-release requirements.

---

## 1. v1 Thesis

Thor v1 is the **production-readiness release**, not a feature dump.

v0 establishes the foundation:

```txt
Schema DSL
  ↓
Typed Query Builder
  ↓
Typed + Runtime IR
  ↓
Guards
  ↓
Capability Matrix
  ↓
Dialect Compiler
  ↓
Effect Executor
  ↓
Decoded Result
```

v1 proves that foundation can support real applications:

```txt
Compiled queries
Explicit relations
Production migrations
Multi-dialect contracts
Node + Bun runtime lanes
Observability
Full-feature SQL testing
Hot-path benchmarks
LLM skills
Public API stability
```

Thor remains:

```txt
Drizzle-like authoring
+
Effect-native typed execution
+
Capability-safe SQL IR
+
Runtime-safe decoding
+
Safe routines
+
Safe migrations
+
First-class testing
+
First-class benchmarking
```

Thor is **not** just an ORM that returns `Effect`. It is a database toolkit where database semantics, SQL dialect semantics, runtime semantics, and Effect semantics meet in a typed/runtime IR.

---

## 2. v1 Core Invariants

The v0 invariants remain active in v1.

```txt
The query builder is pure.
The IR is the source of truth.
The capability matrix guards every dialect feature.
Effect owns execution, errors, services, resources, scopes, and observability.
Thor must not make database I/O meaningfully slower.
```

Additional v1 invariants:

```txt
Compiled queries must bypass cold-path work.
Relations must lower into normal query IR.
Dialect adapters must pass shared capability-aware contract suites.
Runtime support must be tested under the actual runtime.
Migrations must be safe by policy, not by convention.
Observability must not leak parameter values by default.
LLM skills are guidance; Thor guards remain the source of truth.
```

---

## 3. v1 Goals

Thor v1 should focus on these pillars:

```txt
1. Production-grade query API
2. Stable compiled query API
3. Explicit relational layer
4. Real dialect contract suite for Postgres, SQLite, and MySQL
5. Runtime compatibility for Node and Bun
6. Production migration workflows
7. Schema introspection and drift detection
8. Mature function/procedure support
9. First-class observability
10. Full-feature SQL test matrix
11. Hot-path benchmark discipline
12. LLM skill files for safe agent usage
13. Public API stability boundaries
```

---

## 4. v1 Non-Goals

Thor v1 should avoid:

```txt
- ActiveRecord-style entity lifecycle
- Magical lazy loading
- Hidden implicit transactions
- Decorator-heavy model definitions
- Runtime reflection as the primary API
- Vendor-specific behavior hidden behind fake portability
- Cost-based SQL optimizer
- Distributed transaction manager
- GraphQL or REST API generation
- Silent destructive migrations
- Silent dialect emulation
- Silent unsafe raw SQL usage
```

Thor should remain explicit, typed, testable, benchmarked, and capability-aware.

---

## 5. Package Identity and Layout

### 5.1 Placeholder packages

Initial package names remain:

```txt
@gilvandovieira/thor
@gilvandovieira/cli
```

The CLI binary remains:

```txt
thor
```

### 5.2 Flat package principle

Thor should keep the flat package strategy from v0.

Prefer:

```txt
@gilvandovieira/thor
@gilvandovieira/cli
```

With subpath exports:

```ts
import { pg } from "@gilvandovieira/thor/postgres"
import { sqlite } from "@gilvandovieira/thor/sqlite"
import { mysql } from "@gilvandovieira/thor/mysql"
import { defineMigration } from "@gilvandovieira/thor/migrate"
import { FakeDatabaseLayer } from "@gilvandovieira/thor/testing"
import { defineFunction } from "@gilvandovieira/thor/routine"
```

Avoid premature package splitting:

```txt
@gilvandovieira/core
@gilvandovieira/schema
@gilvandovieira/postgres
@gilvandovieira/testing
```

Splitting may happen later only if one of these becomes true:

```txt
- dependency weight becomes too high
- independent versioning becomes necessary
- users clearly need isolated installation
- runtime-specific code pollutes the main package
- benchmarks show subpath/package isolation materially helps
```

### 5.3 v1 subpath exports

Shipped v1 subpaths:

```txt
@gilvandovieira/thor
@gilvandovieira/thor/schema
@gilvandovieira/thor/sql
@gilvandovieira/thor/capabilities
@gilvandovieira/thor/postgres
@gilvandovieira/thor/sqlite
@gilvandovieira/thor/mysql
@gilvandovieira/thor/migrate
@gilvandovieira/thor/testing
@gilvandovieira/thor/routine
@gilvandovieira/thor/relations
@gilvandovieira/thor/introspect
@gilvandovieira/thor/observability
@gilvandovieira/thor/skills
```

Low-level IR, guard collectors, cache implementations, and normalization/hash
helpers are internal and intentionally have no public subpath. Guard assertions
for consumers live under `/testing`. Benchmarks are repository commands rather
than an importable package API. Experimental runtime capability APIs live under
`/capabilities`; a separate `/runtime` route is deferred.

### 5.4 Suggested v1 repository layout

```txt
packages/
  thor/
    src/
      index.ts

      schema/
      sql/
      ir/
      capabilities/
      guards/
      errors/

      postgres/
      sqlite/
      mysql/

      runtime/
        index.ts
        node.ts
        bun.ts
        capabilities.ts

      migrate/
      routine/
      relations/
      introspect/
      observability/
      testing/
      bench/

  cli/
    src/
      index.ts
      commands/
        init.ts
        create.ts
        generate.ts
        check.ts
        status.ts
        up.ts
        down.ts
        redo.ts
        drift.ts
        pull.ts
        inspect.ts
        capabilities.ts
        bench.ts
        doctor.ts
        skills.ts

skills/
  thor/
    README.md
    manifest.json
    schema.skill.md
    query.skill.md
    effect-execution.skill.md
    migrations.skill.md
    capabilities.skill.md
    routines.skill.md
    testing.skill.md
    dialects.skill.md
    debugging.skill.md
    safety.skill.md
```

---

## 6. Public API Stability Levels

v1 must define API stability explicitly.

### 6.1 Stable APIs

```txt
- schema DSL
- fluent query builder
- execution methods: all, one, maybeOne, run
- compiled query API
- migration file format
- public tagged errors
- capability names
- dialect adapter interface
- basic testing helpers
- CLI migration commands
```

### 6.2 Experimental APIs

```txt
- relation layer
- introspection output shape
- unsafe-hot performance mode
- routine introspection
- advanced runtime capability APIs
- LLM skill export formats beyond Markdown
```

### 6.3 Internal APIs

```txt
- low-level IR node internals
- optimizer internals
- cache internals
- prepared statement cache internals
- compiler implementation details
```

The IR may be inspectable without being fully stable.

Example:

```ts
query.inspect()
```

`inspect()` should be stable enough for debugging and testing, but not necessarily stable enough for third-party compiler plugins in v1.

`stream()` is deferred. The shipped `Driver` contract returns materialized row
arrays and has no scoped cursor abstraction, so Thor must not present `.all()` as
streaming. `query.streaming` remains a stable capability name but is
`unsupported` for every shipped adapter until cursor lifetime, interruption,
per-row decoding, transaction affinity, and observability are implemented and
live-tested per driver.

---

## 7. Typed and Runtime IR in v1

v1 keeps the dual IR model.

```txt
Type-level IR
  → result type, error type, requirements, capabilities, scope, cardinality, params

Runtime IR
  → AST, guards, capabilities, decoders, annotations, tracing metadata, compiler input
```

Conceptual shape:

```ts
type QueryIR<
  Output,
  Error,
  Requirements,
  Capabilities,
  Scope,
  Cardinality,
  Params
> = {
  readonly ast: RuntimeQueryNode
  readonly decoder: RowDecoder<Output>
  readonly params: Params
  readonly capabilities: ReadonlySet<Capability>
  readonly cardinality: Cardinality
  readonly scope: RuntimeScope
  readonly annotations: QueryAnnotations
}
```

v1 must ensure the IR powers:

```txt
- compile-time result inference
- compile-time scope safety
- capability accumulation
- error inference
- Effect requirements inference
- guard execution
- dialect compilation
- prepared cache keys
- row decoding
- observability
- test snapshots
- benchmark stage measurement
```

---

## 8. Compiled Query API

### 8.1 Purpose

v0 may memoize internally. v1 must expose a stable compiled query API.

Compiled queries are the main hot-path API.

They should bypass:

```txt
- full fluent rebuild
- full IR normalization
- full guard traversal
- full SQL recompilation
- decoder reconstruction
```

They may still perform:

```txt
- cheap capability/version validation
- parameter validation, depending on mode
- prepared statement lookup
- driver execution
- row decoding, depending on mode
```

### 8.2 Example

```ts
const FindUserByEmail = db
  .select({
    id: users.id,
    email: users.email
  })
  .from(users)
  .where(eq(users.email, param("email", Schema.String)))
  .one()
  .compile()

const user = yield* FindUserByEmail.execute({
  email: "lucas@example.com"
})
```

### 8.3 Conceptual type

```ts
type CompiledQuery<
  Params,
  Output,
  Error,
  Requirements,
  Dialect,
  Cardinality
> = {
  readonly cacheKey: string
  readonly dialect: Dialect
  readonly cardinality: Cardinality
  readonly capabilities: ReadonlySet<Capability>

  execute(
    params: Params
  ): Effect.Effect<Output, Error, Requirements>
}
```

### 8.4 Compiled query invariant

```txt
Compiled query invariant:

A compiled query represents a validated query shape, not a set of values.
Values are supplied at execution time through parameters. Compiled queries
must not bake user input into cache keys or SQL strings.
```

---

## 9. Query Cache and Precompilation

v1 should formalize caches instead of leaving them as ad hoc optimizations.

### 9.1 Cache layers

```txt
Shape cache
  Query IR shape → normalized IR

Compile cache
  Normalized IR + dialect → compiled SQL

Prepared cache
  Compiled SQL + connection/pool → prepared statement handle

Decoder cache
  Selection shape → row decoder

Capability cache
  Query capability bits + dialect matrix version → capability result
```

### 9.2 Cache key rule

Cache keys must represent shape, not values.

Good cache shape:

```txt
select users.id, users.email
from users
where users.email = ?
```

Bad cache shape:

```txt
select users.id, users.email
from users
where users.email = 'lucas@example.com'
```

### 9.3 API

```ts
db.withQueryCache({
  maxSize: 10_000,
  strategy: "lru"
})

const q = query.compile({
  cache: true,
  prepare: true
})
```

### 9.4 Precompilation modes

```txt
compile()
  Validates and compiles query shape.

compilePrepared()
  Validates, compiles, and prepares when the runtime/driver supports it.

compileUnsafeHot()
  Requires explicit unsafe opt-in and is available only for already validated paths.
```

### 9.5 Prepared-resource lifecycle

Prepared resources are scoped to a physical connection, not merely a query
shape. A bounded query cache must also bound actual prepared admission on each
connection. Eviction releases the client statement where the adapter exposes a
safe release operation; otherwise the adapter executes non-admitted shapes
unprepared rather than growing an unrelated resource cache. Scoped connection
disposal clears retained resources. Compile-cache entries, observation counters,
client handles, and server prepared statements are distinct concepts.

---

## 10. Safety and Performance Modes

v1 may introduce explicit modes.

```ts
db.withMode("safe")
db.withMode("trusted")
db.withMode("unsafe-hot")
```

### 10.1 `safe`

Default mode.

```txt
- full guards
- full decode
- full capability checks
- best diagnostics
- safest behavior
```

### 10.2 `trusted`

For validated application hot paths.

```txt
- guards and capabilities still active
- reduced decode overhead where safe
- assumes schema/query shape was previously validated
- suitable for compiled queries
```

### 10.3 `unsafe-hot`

Explicit opt-in only.

```txt
- only for precompiled queries
- minimal runtime checks
- no hidden fallback
- no silent emulation
- visibly unsafe in API and IR annotations
```

`unsafe-hot` must never be the default.

---

## 11. Dialect Strategy

### 11.1 v1 dialect targets

```txt
Postgres
  Production target.

SQLite
  Production/local/embedded target.

MySQL
  Compatibility target.
```

SQLite and MySQL were introduced as v0 architectural constraints. In v1, they become real contract targets.

### 11.2 Dialect adapter contract

```ts
interface DialectAdapter {
  readonly id: DialectId
  readonly capabilities: CapabilityMatrix
  readonly compiler: SqlCompiler
  readonly migrationCompiler: MigrationCompiler
  readonly introspector: Introspector
  readonly driver: DriverFactory
}
```

A dialect adapter is not valid merely because it compiles SQL. It must:

```txt
- declare a capability matrix
- pass compiler snapshot tests
- pass fake driver tests
- pass real integration tests for supported features
- fail unsupported features before execution
- participate in benchmarks
```

### 11.3 Capability statuses

```txt
native
  The dialect supports the feature directly.

emulated
  Thor may support the feature only with explicit emulation policy.

unsupported
  Thor must fail before execution with CapabilityError.

unknown
  Thor must fail conservatively.
```

### 11.4 Capability-aware test rule

```txt
If capability is native:
  feature must execute correctly.

If capability is emulated:
  feature must execute only when emulation is explicitly enabled.

If capability is unsupported:
  feature must fail with CapabilityError before execution.

If capability is unknown:
  feature must fail conservatively.
```

### 11.5 Dialect-specific behavior must remain isolated

Core abstractions must not become Postgres-shaped.

Dialect-specific behavior belongs in:

```txt
- dialect capability matrix
- dialect compiler
- dialect migration compiler
- dialect introspector
- dialect driver adapter
- dialect routine definitions
```

### 11.6 Pool-backed layer naming

A layer named `PoolLayer` must borrow per operation and pin one connection only
inside a transaction. A layer that acquires one connection for its entire
lifetime must use an explicit dedicated-connection name. Thor's current
node-postgres/mysql2 pool adapters are
`PostgresDedicatedPoolConnectionLayer` and
`MySQLDedicatedPoolConnectionLayer`; they provide affinity, not pool-wide
concurrency.

`preparedStatements` controls actual prepared execution. For mysql2, enabled
parameterized execution uses `execute`; disabled execution uses `query` with
bound values. Parameter-free statements use `query` in either mode.

---

## 12. Runtime Strategy: Node + Bun

Thor v1 supports two runtime lanes:

```txt
Node
Bun
```

Runtime support is separate from database dialect support.

```txt
Database dialects:
  postgres
  sqlite
  mysql

JavaScript runtimes:
  node
  bun
```

### 12.1 Runtime capability matrix

Runtime capabilities should be modeled separately:

```ts
type RuntimeCapability =
  | "runtime.node"
  | "runtime.bun"
  | "runtime.webCrypto"
  | "runtime.nodeCrypto"
  | "runtime.fs"
  | "runtime.process"
  | "runtime.workerThreads"
  | "runtime.testRunner"
  | "runtime.sqlite.bun"
  | "runtime.napi"
```

### 12.2 Runtime-specific code boundaries

Core Thor remains runtime-neutral.

Runtime-specific code may exist in:

```txt
- driver adapters
- test layers
- CLI execution paths
- filesystem/config loading
- native adapter handling
- Bun-specific SQLite driver support
```

### 12.3 Bun-specific opportunity

SQLite may support a Bun driver path:

```txt
SQLite dialect
  shared SQL compiler
  Node driver adapter
  Bun driver adapter using Bun-native SQLite support
```

### 12.4 Runtime testing invariant

```txt
Runtime testing invariant:

Thor must separate database dialect behavior from JavaScript runtime
behavior. A dialect adapter may have different driver implementations per
runtime, but it must expose the same Thor Database service contract.
Runtime support is valid only when the adapter passes the shared contract
suite under that runtime.
```

---

## 13. Relation Layer

### 13.1 Purpose

v1 may introduce a relation layer built on top of the fluent SQL/IR layer.

The relation layer must not bypass the IR.

```txt
Relation query
  ↓
Relation planner
  ↓
Query IR
  ↓
Guards
  ↓
Capabilities
  ↓
Compiler
  ↓
Effect executor
```

### 13.2 Example

```ts
const users = pg.table("users", {
  id: pg.uuid("id").primaryKey(),
  email: pg.text("email").notNull()
})

const posts = pg.table("posts", {
  id: pg.uuid("id").primaryKey(),
  userId: pg.uuid("user_id").references(() => users.id),
  title: pg.text("title").notNull()
})

const relations = defineRelations({
  users: {
    posts: many(posts, {
      fields: [users.id],
      references: [posts.userId]
    })
  },

  posts: {
    author: one(users, {
      fields: [posts.userId],
      references: [users.id]
    })
  }
})
```

Usage:

```ts
db.relation(users).findMany({
  with: {
    posts: {
      strategy: "join"
    }
  }
})
```

### 13.3 Loading strategies

Relations must be explicit about loading strategy.

```txt
join
  Single query using joins.

query
  Multiple queries batched by keys.

manual
  User controls composition directly.
```

### 13.4 No hidden N+1

```txt
Relation invariant:

Thor must not perform hidden N+1 queries. If a relation query would produce
N+1 behavior, Thor must reject it, batch it, or require explicit opt-in.
```

### 13.5 Relation non-goals for v1

```txt
- lazy loading by property access
- implicit unit-of-work identity map
- automatic mutation graph persistence
- entity lifecycle hooks
```

---

## 14. Routines: Functions and Procedures

v1 hardens the routine system introduced in v0.

### 14.1 Core distinction

```txt
Functions = expressions
Procedures = executable commands/effects
```

Functions can be used inside queries:

```ts
db
  .select({ lowerEmail: pg.fn.lower(users.email) })
  .from(users)
```

Procedures execute through Effect:

```ts
yield* db
  .procedure(refreshUserStats)
  .call({ userId })
```

### 14.2 Routine categories

```txt
ScalarFunctionCall
AggregateFunctionCall
WindowFunctionCall
TableFunctionCall
ProcedureCall
```

Do not collapse all routines into a generic function call node.

### 14.3 Routine metadata

Routine definitions should include:

```txt
- name/schema
- args
- return type
- overloads
- named/positional args
- default args where supported
- volatility
- nullability
- side effects
- idempotency
- transaction requirements
- required extensions/features
- capabilities
```

### 14.4 Example function

```ts
const normalizeEmail = pg.defineFunction("public.normalize_email", {
  args: [pg.text()],
  returns: pg.text(),
  volatility: "immutable",
  nullability: "returns-null-on-null-input"
})
```

### 14.5 Example procedure

```ts
const refreshUserStats = pg.defineProcedure("refresh_user_stats", {
  args: {
    userId: pg.uuid()
  },
  returns: {
    refreshedAt: pg.timestamp(),
    changedRows: pg.integer()
  },
  effects: {
    mutates: ["user_stats"],
    idempotency: "idempotent",
    requiresTransaction: false
  }
})
```

### 14.6 Routine safety invariant

```txt
Routine safety invariant:

Database functions and procedures must be represented in the IR as declared,
typed routine references. Routine names are never interpolated from unchecked
strings. Function calls are expressions; procedure calls are executable
commands. Routine metadata must describe argument types, return types,
capabilities, volatility, side effects, idempotency, and transaction
requirements so the Effect runtime can enforce safe execution.
```

---

## 15. Migrations v1

v0 supports manual and generated migrations. v1 makes migrations production-shaped.

### 15.1 v1 migration features and limits

```txt
- schema introspection
- drift detection
- dry-run planning
- migration plan review
- expand/contract strategies
- migration locks
- migration checksums
- transactional DDL capability awareness
- environment policies
- typed backfill helper
- generated migration tests
- routine/function/procedure DDL support
```

The shipped generator is create-table-only. It does not infer column changes,
renames, standalone index/constraint changes, enums, views, generated/identity
alterations, or routine changes. `planExpandContract` is a narrow programmatic
column-replacement helper, not a CLI `--strategy` generator, and its full
add/backfill/require/drop sequence currently compiles end-to-end only for
PostgreSQL. There is no dedicated seed workflow.

### 15.2 CLI commands

```sh
thor init
thor create add_users_table
thor generate add_users_table
thor check
thor status
thor up
thor down
thor redo
thor drift
thor pull
thor inspect
```

### 15.3 Programmatic API

```ts
const program = Effect.gen(function* () {
  const migrator = yield* Migrator

  yield* migrator.check()
  yield* migrator.drift()
  yield* migrator.up()
})
```

Expected APIs:

```ts
Migrator.diff(currentSchema)
Migrator.plan(currentSchema)
Migrator.check()
Migrator.status()
Migrator.up()
Migrator.down()
Migrator.drift() // legacy create-missing-table operations, not structural drift
Migrator.dryRun()
Migrator.apply(plan)
```

### 15.4 Migration policies

```ts
type MigrationPolicy =
  | "disabled"
  | "validate-only"
  | "safe-only"
  | "expand-only"
  | "allow-reviewed-destructive"
```

Default production policy should not allow destructive auto-migration.

### 15.5 Expand/contract workflow

For production-safe schema changes:

```txt
expand
  Add nullable/new structures without breaking old code.

backfill
  Migrate data safely.

contract
  Remove old structures after code no longer depends on them.
```

Example:

```sh
planExpandContract("rename_user_name_to_display_name", { ... })
```

May generate:

```txt
001_add_display_name
002_backfill_display_name
003_make_display_name_required
004_drop_name
```

Destructive steps must remain blocked unless explicitly reviewed.

### 15.6 Migration journal

The journal table from v0 remains:

```sql
create table _thor_migrations (
  id text primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null,
  execution_time_ms integer not null
);
```

Checksum mismatch should be a hard error by default.

New journal rows use `sha256:v1:<digest>` over a canonical representation of all
execution-relevant fields: ID, name, up/down representation, Effect revision,
irreversible marker, and safety/phase metadata. Matching legacy unversioned
FNV-1a rows remain readable without silent rewrite. Unknown algorithms fail
clearly.

### 15.7 Migration invariant

```txt
Migration invariant:

Generated plans use migration IR, dialect compilation, and structural policy
checks. Manual SQL and Effect migrations are opaque execution steps whose
semantics cannot be inferred; they require explicit safety and phase metadata
and use the same journal, lock, transaction, and policy executor. Structural
drift is provided by `Introspector.drift`; legacy `Migrator.drift` reports only
missing expected tables. Destructive, irreversible, dialect-unsafe, or drifted
operations must be blocked unless explicitly approved by policy.
```

---

## 16. Introspection and Drift Detection

### 16.1 Purpose

Thor v1 should inspect live databases and compare them against schema-as-code.

Introspection does not replace schema-as-code. It verifies and compares against it.

### 16.2 CLI

```sh
thor pull
thor introspect
thor drift
thor inspect schema
thor inspect routines
```

### 16.3 Programmatic API

```ts
const current = yield* Introspector.currentSchema()
const drift = yield* Introspector.drift(expectedSchema)
```

### 16.4 Introspection output

The shipped introspector produces Schema IR including:

```txt
- tables
- columns
- indexes
- constraints
- foreign keys
```

Types and defaults are recorded but deliberately not compared by drift. Enums,
views, routines, extensions, unique/check constraints, and generated/identity
metadata are deferred catalog surfaces.

### 16.5 Drift invariant

```txt
Drift invariant:

Thor must detect when the live database shape differs from the expected schema
snapshot or schema-as-code model. Drift must be reported before applying
migrations unless explicitly ignored by policy.
```

---

## 17. Observability

v1 should expose observability through Effect-friendly metadata, spans, logs, and metrics.

### 17.1 Query metadata

Every executed query should produce structured metadata:

```txt
- operation kind
- dialect
- runtime
- table names
- query hash
- compiled cache hit/miss
- prepared cache hit/miss
- duration
- row count
- error tag
- transaction id/scope
- migration id, if migration
```

### 17.2 Span naming

Examples:

```txt
thor.query.select.users
thor.query.insert.posts
thor.query.update.sessions
thor.transaction.commit
thor.transaction.rollback
thor.migration.apply
thor.migration.drift
```

### 17.3 Parameter logging

Do not log raw parameter values by default.

Modes:

```txt
none
redacted
unsafe-full
```

`unsafe-full` must be explicit and visibly unsafe.

### 17.4 API

```ts
db.withObservability({
  tracing: true,
  metrics: true,
  logSql: "summary",
  logParams: "redacted"
})
```

### 17.5 Observability invariant

```txt
Observability invariant:

Thor must make database behavior visible without leaking sensitive data by
default. Query summaries, operation metadata, cache behavior, and error tags
should be observable; raw parameters require explicit unsafe opt-in.
```

---

## 18. Testing v1

Testing remains a first-class design axis.

### 18.1 Testing layers

```txt
Compile-time type tests
  ↓
Pure IR tests
  ↓
Guard/capability tests
  ↓
Compiler snapshot tests
  ↓
Fake driver execution tests
  ↓
Real dialect contract tests
  ↓
Migration/integration tests
  ↓
Runtime lanes: Node + Bun
```

### 18.2 Unit test suites

```txt
schema tests
query builder tests
IR tests
guard tests
capability tests
compiler tests
routine tests
migration planner tests
introspection tests
relation planner tests
cache tests
observability tests
```

### 18.3 Integration test strategy

Effect owns resource acquisition/release through Layers. Thor owns the integration contract.

```txt
Effect Layer manages connection/pool lifecycle.
Thor tests verify schema, query, transaction, migration, decoding, and dialect behavior.
```

Integration tests must use real databases through Thor APIs, not manually managed connections in every test.

### 18.4 Isolation strategy

For Postgres/MySQL:

```txt
One database container/process
  ↓
One schema/database per test worker
  ↓
Run migrations into that schema/database
  ↓
Each test uses transaction rollback or explicit cleanup
```

For SQLite:

```txt
In-memory database for fast tests
File database for migration/persistence tests
Bun-native SQLite path for Bun runtime lane
```

Isolation modes:

```txt
transaction-per-test
schema-per-worker
database-per-suite
container-per-suite
```

Do not wrap transaction-manager tests in an outer rollback transaction, because it can hide transaction bugs.

### 18.5 Dialect contract suite

Each dialect should run the same capability-aware suite:

```ts
describeDialect("postgres", PostgresTestLayer)
describeDialect("sqlite", SQLiteTestLayer)
describeDialect("mysql", MySQLTestLayer)
```

Suite categories:

```txt
- connect through Layer
- create schema
- run migrations
- insert/select/update/delete
- returning support where native
- unsupported returning failure where unsupported
- constraint error mapping
- transaction commit
- transaction rollback
- nested transaction/savepoint
- row decoding
- timestamp/json/uuid codecs
- functions/procedures where supported
- migration journal behavior
- capability failures
```

### 18.6 Full SQL feature matrix tests

Thor v1 should add feature tests from simple to advanced SQL.

#### Simple SQL

```txt
select
insert
update
delete
where
order by
limit
offset
basic params
basic aliases
```

#### Intermediate SQL

```txt
inner join
left join
right join where supported
cross join
group by
having
aggregates
subqueries
insert returning
update returning
delete returning
upsert/conflict handling
```

#### Advanced SQL

```txt
CTEs
recursive CTEs
window functions
JSON operations
array operations
lateral joins
table-valued functions
procedures
transactions
savepoints
isolation levels
streaming (deferred; all shipped adapters report unsupported)
prepared statements
views
```

#### Schema/Migration SQL

```txt
create table
alter table
indexes
unique constraints
foreign keys
generated columns
identity columns
enum handling
views
functions/procedures
destructive migration guards
drift detection
```

Every feature must be tested according to dialect capability status.

### 18.7 Property and fuzz tests

Property tests should cover IR/compiler invariants:

```txt
- compiler never emits unbound params
- every param appears in the param list
- normalization is idempotent
- capability requirements survive optimization
- unsupported capabilities fail before execution
- query shape hash ignores values
- SQL identifiers are quoted consistently
- empty/invalid mutations fail guards
```

### 18.8 Testing invariant

```txt
Testing invariant:

Every new feature must include tests at the right layer: type tests for type
behavior, IR tests for builder semantics, guard/capability tests for safety,
compiler snapshots for SQL generation, fake driver tests for runtime contracts,
and integration tests for real database behavior where applicable.
```

---

## 19. Benchmarks v1

Benchmarks are part of the design, not marketing.

### 19.1 Benchmark groups

```txt
bench:build
bench:ir
bench:normalize
bench:guard
bench:capability
bench:compile
bench:cache
bench:prepared
bench:decode
bench:effect
bench:integration
bench:migrate
bench:runtime-node
bench:runtime-bun
```

### 19.2 Stage measurement

Benchmarks must measure stages independently:

```txt
query construction
IR construction
IR normalization
guard checks
capability checks
SQL compilation
cache lookup
prepared statement lookup
Effect execution boundary
row decoding
driver execution
```

No single "ORM benchmark" number is enough.

### 19.3 Hot-path targets

Thor overhead means Thor code only, excluding real database I/O and driver time.

```txt
Cold path:
  allowed to be slower because it performs full validation/compile.

Warm cached path:
  target 1–2µs Thor overhead where realistic.

Smallest hot synthetic path:
  ideal sub-microsecond Thor overhead.

Network database integration:
  Thor overhead should usually disappear behind I/O.

SQLite/Bun integration:
  overhead is more visible and becomes the stress case.
```

### 19.4 Performance strategies

Thor should use all appropriate strategies:

```txt
- memoization
- precompilation
- stable structural hashing
- compact IR nodes
- compact capability bitsets
- shape-based cache keys
- prepared statement caching
- decoder caching
- param shape separation
- avoiding deep cloning
- avoiding Effect in tiny pure builder operations
- avoiding unnecessary allocations in compiler hot paths
```

### 19.5 Benchmark baselines

Compare against:

```txt
- raw handwritten SQL
- minimal object builder baseline
- Drizzle-like query builder where applicable
- Thor cold path
- Thor warm cached path
- Thor compiled query path
- Thor unsafe-hot path, if enabled
```

### 19.6 Benchmark invariant

```txt
Performance invariant:

The toolkit must treat query construction, IR transformation, guarding,
capability checking, SQL compilation, execution wrapping, and decoding as
measurable hot paths. No feature may add unbounded or hidden overhead to
these paths. Database I/O may be slow; Thor's abstraction should not be the
reason it is slow.
```

---

## 20. CLI v1

The CLI should mature beyond migrations.

### 20.1 Commands

```sh
thor init
thor create
thor generate
thor check
thor status
thor up
thor down
thor redo
thor drift
thor pull
thor inspect
thor capabilities
thor bench
thor doctor
thor skills
```

### 20.2 `thor doctor`

Should check:

```txt
- runtime
- dialect
- driver availability
- database connectivity
- migration table
- pending migrations
- drift status
- capability support
- Node/Bun compatibility
- config validity
```

### 20.3 `thor capabilities`

Examples:

```sh
thor capabilities postgres
thor capabilities sqlite
thor capabilities mysql
thor capabilities runtime bun
```

Should show:

```txt
native
emulated
unsupported
unknown
```

### 20.4 `thor bench`

Examples:

```sh
thor bench query
thor bench compile
thor bench decode
thor bench runtime --bun
thor bench runtime --node
```

### 20.5 `thor skills`

Examples:

```sh
thor skills list
thor skills export
thor skills export --format markdown
thor skills export --format json
thor skills export --to ./.agents/skills/thor
```

---

## 21. LLM Skills

### 21.1 Thesis

Thor should ship machine-readable and human-readable skills that help LLM agents use the toolkit correctly, safely, and consistently.

```txt
LLM skills are guidance.
Thor guards, capability checks, tests, and compilers remain the source of truth.
```

### 21.2 Skill files

Top-level structure:

```txt
skills/
  thor/
    README.md
    manifest.json
    schema.skill.md
    query.skill.md
    effect-execution.skill.md
    migrations.skill.md
    capabilities.skill.md
    routines.skill.md
    testing.skill.md
    dialects.skill.md
    debugging.skill.md
    safety.skill.md
```

### 21.3 Skill file shape

Each skill should be structured:

```md
# Thor Skill: Writing Queries

## Goal

Teach an LLM agent how to write Thor fluent SQL queries safely.

## Use When

- The user asks for database queries.
- The user asks for repository functions.
- The user asks for filtering, joins, sorting, pagination, or mutations.

## Required Checks

- Use schema-defined tables and columns.
- Do not reference tables outside query scope.
- Use params for user input.
- Check dialect capability before using advanced SQL features.
- Use `.one()` only when exactly one row is expected.
- Use `.maybeOne()` when absence is valid.

## Safe Patterns

...

## Unsafe Patterns

...

## Examples

...

## Verification

- Add type tests.
- Add SQL snapshot tests.
- Add integration tests if behavior depends on dialect.
```

### 21.4 Required skills

#### `schema.skill.md`

Covers:

```txt
- table definitions
- columns
- nullability
- defaults
- generated columns
- primary keys
- foreign keys
- indexes
- unique constraints
- select/insert/update inferred types
- Effect Schema codecs
```

Hard rule:

```txt
Do not create schema constructs without checking dialect capabilities.
```

#### `query.skill.md`

Covers:

```txt
- select
- insert
- update
- delete
- joins
- where
- order by
- group by
- having
- subqueries
- CTEs
- returning
- params
- cardinality methods
```

Hard rule:

```txt
Never interpolate user input into raw SQL. Use params and schema-backed values.
```

#### `effect-execution.skill.md`

Covers:

```txt
- queries are pure until execution
- all/one/maybeOne/run; streaming is deferred
- typed errors
- Effect Layers
- Database service requirements
- transactions
- scoped resources
- retry safety
```

Hard rule:

```txt
Do not manually manage connections in userland unless building a driver adapter.
Use Thor/Effect Layers.
```

#### `migrations.skill.md`

Covers:

```txt
- manual migrations
- generated migrations
- schema snapshots
- migration journal
- drift detection
- destructive guards
- expand/contract migrations
- migration policies
```

Hard rule:

```txt
Never generate destructive migrations as safe defaults. Drop table/drop column/type narrowing require explicit approval.
```

#### `capabilities.skill.md`

Covers:

```txt
- native
- emulated
- unsupported
- unknown
- dialect capability checks
- runtime capability checks
- feature fallback behavior
```

Hard rule:

```txt
If a capability is unsupported or unknown, fail conservatively. Do not fake portability.
```

#### `routines.skill.md`

Covers:

```txt
- scalar functions
- aggregate functions
- window functions
- table-valued functions
- procedures
- volatility
- idempotency
- transaction requirements
- unsafe dynamic routine names
```

Hard rule:

```txt
Functions are expressions. Procedures are Effect operations. Do not collapse them into the same API.
```

#### `testing.skill.md`

Covers:

```txt
- type tests
- IR tests
- guard tests
- SQL snapshots
- fake driver tests
- integration tests
- dialect contract tests
- migration tests
```

Hard rule:

```txt
Every new feature needs tests at the correct layer. Do not rely only on integration tests.
```

#### `dialects.skill.md`

Covers:

```txt
- Postgres
- SQLite
- MySQL
- dialect differences
- SQL compilation differences
- migration differences
- function/procedure differences
```

Hard rule:

```txt
Do not write Postgres-shaped core abstractions. Dialect-specific behavior belongs in dialect adapters.
```

#### `debugging.skill.md`

Covers:

```txt
- reading query.inspect()
- reading capability errors
- reading compile errors
- reading decode errors
- reading migration errors
- checking generated SQL
- using thor doctor
```

Hard rule:

```txt
Debug from IR → capabilities → SQL → execution → decode. Do not jump straight to raw SQL rewrites.
```

#### `safety.skill.md`

Covers:

```txt
- unsafe raw SQL
- unsafe routines
- destructive migrations
- unsafe-hot mode
- parameter logging
- production migration policy
```

Hard rule:

```txt
Unsafe paths must be explicit, visible in the API, and testable.
```

### 21.5 Manifest

Example:

```json
{
  "name": "thor",
  "version": "1.0.0-draft",
  "project": "Thor Project",
  "scope": "@gilvandovieira",
  "skills": [
    {
      "id": "thor.schema",
      "file": "schema.skill.md",
      "description": "Define Thor schemas safely."
    },
    {
      "id": "thor.query",
      "file": "query.skill.md",
      "description": "Write Thor fluent SQL queries safely."
    },
    {
      "id": "thor.migrations",
      "file": "migrations.skill.md",
      "description": "Create and review Thor migrations."
    }
  ]
}
```

### 21.6 LLM usage invariant

```txt
LLM usage invariant:

Thor should provide skill files that teach LLM agents to operate through
Thor's schema DSL, query builder, migration planner, capability matrix,
testing helpers, and benchmark tools. Agents should prefer declared Thor APIs
over raw SQL, check capabilities before using dialect-specific features,
generate tests and benchmarks with feature changes, and never bypass safety
guards unless the user explicitly requests an unsafe path.
```

---

## 22. Error Model v1

The tagged error model remains.

```ts
type ThorError =
  | CapabilityError
  | CompileError
  | DriverError
  | ConstraintError
  | DecodeError
  | MigrationError
  | TransactionError
  | TimeoutError
  | RoutineError
  | IntrospectionError
  | RelationPlanningError
  | CacheError
  | RetrySafetyError
```

Every error must have:

```txt
- _tag
- stable category
- structured fields
- optional cause
- safe summary
```

Error messages should be useful, but tests should assert structured tags and fields, not fragile message strings.

---

## 23. Documentation v1

v1 docs should be organized around workflows:

```txt
- Getting started
- Defining schemas
- Writing queries
- Executing with Effect
- Transactions
- Migrations
- Relations
- Functions and procedures
- Dialects
- Runtimes: Node and Bun
- Testing
- Benchmarks
- Observability
- CLI
- LLM skills
- Safety and unsafe APIs
```

Every advanced feature should include:

```txt
- API example
- generated SQL example
- capability notes
- testing example
- benchmark note if hot-path relevant
- safety caveats
```

---

## 24. v1 Milestone Plan

### v1-alpha.1 — Compiled Query and Cache Foundation

```txt
- compiled query API
- shape cache
- compile cache
- decoder cache
- prepared cache interface
- hot-path benchmarks
- cache tests
```

### v1-alpha.2 — Dialect Contract Expansion

```txt
- shared dialect contract suite
- SQLite real adapter path
- MySQL capability-aware adapter path
- Postgres contract hardening
- unsupported feature tests
```

### v1-alpha.3 — Runtime Lanes

```txt
- Node runtime lane
- Bun runtime lane
- runtime capability matrix
- Bun SQLite driver path
- runtime benchmarks
```

### v1-alpha.4 — Migration Hardening and Introspection

```txt
- drift detection
- schema introspection
- dry-run migration plans
- expand/contract strategy
- migration policies
- thor doctor migration checks
```

### v1-alpha.5 — Relation Layer

```txt
- defineRelations()
- one/many relations
- join strategy
- query/batched strategy
- N+1 detection/guarding
- relation planner tests
```

### v1-beta — Observability, Skills, API Stability

```txt
- observability metadata/spans/metrics
- LLM skill files
- thor skills export
- public API stability pass
- docs pass
- benchmark gates stabilized
```

---

## 25. v1 Acceptance Criteria

Thor v1 is ready when:

```txt
- Compiled query API exists and is documented.
- Query cache, compile cache, prepared cache, and decoder cache are benchmarked.
- Warm cached execution path has measured overhead baselines.
- Postgres adapter passes full contract suite.
- SQLite adapter passes capability-aware contract suite.
- MySQL adapter passes capability-aware contract suite or is explicitly marked partial.
- Node runtime test lane passes.
- Bun runtime test lane passes for supported adapters.
- Migration CLI supports generate/create/up/down/status/drift/pull/inspect.
- Programmatic migrator works through Effect.
- Migration policies block destructive production behavior by default.
- Introspection and drift detection are implemented for supported dialects.
- Relation layer supports explicit loading strategies and no hidden N+1 behavior.
- Functions/procedures are typed, guarded, and capability-aware.
- Observability emits structured metadata without leaking params by default.
- Full SQL feature matrix exists and is capability-aware.
- Unsupported capabilities fail before execution.
- Benchmarks establish cold/warm/hot baselines under Node and Bun.
- LLM skill files exist for schema, queries, migrations, capabilities, routines, testing, benchmarks, dialects, debugging, and safety.
- CLI can export LLM skills into an agent workspace.
- Public tagged errors are stable and documented.
- Stable/experimental/internal API boundaries are documented.
```

---

## 26. Working v1 Statement

```txt
Thor v1 is the production-readiness release.

It keeps the v0 foundation of typed/runtime IR, guards, capabilities, Effect
execution, tests, and benchmarks, then adds mature dialect support, compiled
queries, explicit relations, production migrations, introspection, runtime
support for Node and Bun, safe routine handling, observability, LLM skills,
and benchmarked hot paths.
```

Thor v1 should prove that the architecture is not only safe and expressive, but also fast, portable, testable, and usable by both humans and agents.
