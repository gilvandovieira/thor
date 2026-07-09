# Thor Project Specification

**Status:** Draft v0
**Project placeholder name:** Thor Project
**Package scope placeholder:** `@gilvandovieira`
**Primary package:** `@gilvandovieira/thor`
**CLI package:** `@gilvandovieira/cli`
**Primary goal:** Effect-native ORM/database toolkit with fluent schema/query authoring, typed/runtime IR, executable capability matrix, strong guards, safe migrations, safe routine calls, first-class testing, and first-class benchmarks.

---

## 1. Project Thesis

Thor is a schema-first, fluent, Effect-native SQL/database toolkit.

It should feel ergonomic like a modern TypeScript query builder, but its internal model must be deeper:

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

Thor is **not** just an ORM that returns `Effect`.

Thor's identity is:

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

The toolkit must be designed around the idea that database semantics, Effect semantics, and SQL dialect capabilities meet inside the IR.

---

## 2. Package Identity and Layout

### 2.1 Placeholder names

Initial package names:

```txt
@gilvandovieira/thor
@gilvandovieira/cli
```

The project name and scope are placeholders and may be renamed later.

### 2.2 Package design principle

Thor should prefer a **flat package design** where possible.

Avoid creating many separate packages too early.

Initial design:

```txt
@gilvandovieira/thor
@gilvandovieira/cli
```

Use subpath exports inside `@gilvandovieira/thor` when that avoids creating another package prematurely.

Example imports:

```ts
import { pg, db, sql } from "@gilvandovieira/thor"

import { defineTable } from "@gilvandovieira/thor/schema"
import { defineMigration } from "@gilvandovieira/thor/migrate"
import { FakeDatabaseLayer } from "@gilvandovieira/thor/testing"
import { defineFunction } from "@gilvandovieira/thor/routine"
```

The CLI package remains separate:

```txt
@gilvandovieira/cli
```

The CLI binary name should be:

```txt
thor
```

Example:

```sh
thor generate add_users_table
thor up
thor status
```

### 2.3 Suggested repository layout

```txt
packages/
  thor/
    src/
      index.ts

      schema/
        index.ts
        table.ts
        column.ts
        constraints.ts
        indexes.ts
        codecs.ts

      sql/
        index.ts
        expressions.ts
        predicates.ts
        query-builder.ts
        ast.ts
        raw.ts

      ir/
        index.ts
        query-ir.ts
        schema-ir.ts
        migration-ir.ts
        routine-ir.ts

      capabilities/
        index.ts
        matrix.ts
        capability.ts
        postgres.ts

      guards/
        index.ts
        schema-guards.ts
        query-guards.ts
        migration-guards.ts
        routine-guards.ts

      postgres/
        index.ts
        dialect.ts
        compiler.ts
        driver.ts
        routines.ts
        capabilities.ts

      migrate/
        index.ts
        define-migration.ts
        planner.ts
        diff.ts
        journal.ts
        executor.ts
        lock.ts
        snapshot.ts

      routine/
        index.ts
        function.ts
        procedure.ts
        table-function.ts
        aggregate.ts
        window.ts

      testing/
        index.ts
        fake-driver.ts
        fake-database-layer.ts
        expect-sql.ts
        expect-query.ts
        contract-suite.ts
        migration-harness.ts

      bench/
        index.ts
        fixtures.ts
        runner.ts

      errors/
        index.ts

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
        snapshot.ts
        pull.ts
```

### 2.4 Export map direction

`@gilvandovieira/thor` should expose a compact main entry and selected subpaths.

```json
{
  "name": "@gilvandovieira/thor",
  "exports": {
    ".": "./dist/index.js",
    "./schema": "./dist/schema/index.js",
    "./sql": "./dist/sql/index.js",
    "./postgres": "./dist/postgres/index.js",
    "./migrate": "./dist/migrate/index.js",
    "./testing": "./dist/testing/index.js",
    "./routine": "./dist/routine/index.js",
    "./capabilities": "./dist/capabilities/index.js"
  }
}
```

`@gilvandovieira/cli`:

```json
{
  "name": "@gilvandovieira/cli",
  "bin": {
    "thor": "./dist/index.js"
  }
}
```

### 2.5 When to split packages later

Thor should split a subpath into its own package only when there is a concrete reason.

| Candidate | Reason to split |
|---|---|
| `@gilvandovieira/postgres` | Driver/dialect dependencies become heavy |
| `@gilvandovieira/testing` | Users want test helpers without runtime/dialect extras |
| `@gilvandovieira/benchmarks` | Benchmarks are internal-only or too dependency-heavy |
| `@gilvandovieira/migrate` | Migration engine grows independently |
| `@gilvandovieira/schema` | Schema DSL becomes independently useful |

Default rule:

```txt
Keep one main runtime package until package boundaries prove themselves.
```


---

## 2A. Dialect and Runtime Targets

### 2A.1 Database dialect strategy

Thor starts with Postgres as the primary implementation target, but SQLite and MySQL are design constraints from day one.

```txt
Primary v0 implementation target:
  postgres

Design constraint dialects:
  sqlite
  mysql
```

SQLite and MySQL do not need full parity in the first implementation milestone, but their capability matrices should exist early enough to prevent the IR, guards, query builder, migrations, routines, and transaction model from becoming accidentally Postgres-specific.

Initial dialect subpaths should remain inside the flat main package:

```txt
@gilvandovieira/thor/postgres
@gilvandovieira/thor/sqlite
@gilvandovieira/thor/mysql
```

Suggested layout extension:

```txt
packages/thor/src/
  postgres/
    dialect.ts
    compiler.ts
    driver.ts
    capabilities.ts
    routines.ts

  sqlite/
    dialect.ts
    compiler.ts
    driver.ts
    capabilities.ts
    routines.ts

  mysql/
    dialect.ts
    compiler.ts
    driver.ts
    capabilities.ts
    routines.ts
```

A dialect adapter is not valid just because it can compile SQL. It is valid only when it declares a capability matrix and passes the shared capability-aware dialect contract suite.

### 2A.2 JavaScript runtime strategy

Thor should treat JavaScript runtime support as a separate axis from database dialect support.

```txt
Primary runtime:
  Node.js

Runtime compatibility target:
  Bun
```

The core query builder, schema DSL, IR, guards, capability checks, and SQL compiler must remain runtime-neutral. Runtime-specific behavior belongs in driver adapters, test layers, CLI execution paths, and optional runtime integration modules.

Runtime subpaths may exist if useful:

```txt
@gilvandovieira/thor/node
@gilvandovieira/thor/bun
```

Bun support should be especially relevant for SQLite because a Bun-specific SQLite driver can exist while sharing the same SQLite dialect/compiler.

### 2A.3 Runtime capabilities

Thor may model runtime capabilities separately from database capabilities.

Example runtime capabilities:

```txt
runtime.node
runtime.bun
runtime.webCrypto
runtime.nodeCrypto
runtime.fs
runtime.process
runtime.testRunner
runtime.sqlite.bun
runtime.napi
```

Runtime support is valid only when relevant dialect adapters pass the shared contract suite under that runtime.

---

## 3. Scope for v0

Thor v0 should target **Postgres first**.

The architecture must still be capability-driven from day one, even with one dialect.

### 3.1 v0 includes

```txt
- Postgres schema DSL
- Effect Schema-backed codecs
- fluent select/insert/update/delete
- typed query IR
- runtime query IR
- guards
- capability matrix
- SQL compiler
- typed Effect execution
- transaction support
- fake driver testing layer
- SQL snapshot testing
- benchmark suite
- manual migration CLI
- basic automatic migration generation
- function/procedure declaration support
```

### 3.2 v0 avoids

```txt
- full relation/eager-loading system
- multiple production dialects
- complex migration rename intelligence
- cost-based optimizer
- advanced ORM model layer
- heavy plugin system
```

Relations may be added later as a layer on top of the lower-level SQL/query IR.

---

## 4. Core Design Laws

### 4.1 Pure builder, Effect executor

The query builder must be pure.

Bad:

```ts
db.select(...): Effect.Effect<Query, never, never>
```

Good:

```ts
db.select(...): Query
```

Only execution methods return `Effect`:

```ts
query.all()
query.one()
query.maybeOne()
query.run()
query.stream()
```

### 4.2 Effect belongs at boundaries

Use Effect for:

```txt
- execution
- services
- scoped resources
- transactions
- typed errors
- interruption
- streaming
- retries
- logging/tracing integration
- migrations
- test layers
```

Avoid using Effect for every tiny pure AST transformation.

Bad:

```txt
Effect per column
Effect per AST node
Effect per predicate
Effect per tiny normalization step
```

Good:

```txt
Pure builder
Pure IR construction
Pure normalization
Pure compiler where possible
Effect at execution/resource/error boundaries
```

### 4.3 Runtime IR is the source of truth

Type-level IR catches common programmer mistakes.

Runtime IR remains authoritative.

Compile-time should catch:

```txt
- wrong insert shape
- wrong selected type
- table out of scope
- generated column update
- obvious unsupported dialect feature
- invalid fluent chain
```

Runtime should catch:

```txt
- actual dialect capability mismatch
- driver behavior
- constraint violations
- row decoding
- cardinality violations
- transaction lifecycle issues
- migration drift
- unsafe destructive changes
```

### 4.4 No silent emulation

If a feature is unsupported natively, Thor must not silently emulate it.

Example:

```ts
db.insert(users).values(input).returning()
```

If the dialect does not support `INSERT ... RETURNING`, Thor must fail with a typed `CapabilityError` unless emulation was explicitly enabled.

---

## 5. Schema DSL

Schemas should be declared fluently.

Example:

```ts
const users = pg.table("users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull().unique(),
  name: pg.text("name").notNull(),
  age: pg.integer("age").nullable(),
  createdAt: pg.timestamp("created_at").notNull().defaultNow()
})
```

### 5.1 Schema-derived types

Every table should produce at least three types:

```ts
type UserRow = Select<typeof users>
type UserInsert = Insert<typeof users>
type UserUpdate = Update<typeof users>
```

Example:

```ts
type User = Select<typeof users>
// {
//   id: string
//   email: string
//   name: string
//   age: number | null
//   createdAt: Date
// }

type NewUser = Insert<typeof users>
// {
//   email: string
//   name: string
//   age?: number | null
// }
```

Generated/default columns should be omitted from insert unless explicitly allowed.

### 5.2 Schema guards

Schema definitions must be guarded.

Schema guard categories:

| Guard | Example |
|---|---|
| Type/default compatibility | `text().default(123)` should fail |
| Nullable/default logic | `notNull()` without default may affect migrations |
| Primary key rules | Multiple PKs only via explicit composite PK |
| Unique/index references | Index columns must belong to table |
| Dialect support | `array()` blocked if unsupported |
| Codec compatibility | Encoded DB type must decode into runtime type |

### 5.3 Effect Schema integration

Thor should use Effect Schema-backed codecs for validation, decoding, and transformation.

Target use cases:

```txt
- select result decoding
- insert input validation
- update input validation
- JSON column decoding
- timestamp codecs
- branded IDs
- custom database-to-runtime transformations
```

Schema decoding errors should produce typed `DecodeError`, not generic exceptions.

---

## 6. Fluent Query API

Thor should provide a fluent SQL-like query API.

### 6.1 Select

```ts
const q = db
  .select({
    id: users.id,
    email: users.email
  })
  .from(users)
  .where(eq(users.email, "lucas@example.com"))
  .limit(1)
```

Execution:

```ts
const program = q.one()
```

Type conceptually:

```ts
Effect.Effect<
  { id: string; email: string },
  DbError | NotFoundError | TooManyRowsError,
  Database
>
```

### 6.2 Insert

```ts
const createUser = db
  .insert(users)
  .values({
    email: "lucas@example.com",
    name: "Lucas"
  })
  .returning({
    id: users.id,
    email: users.email
  })
```

### 6.3 Update

```ts
const updateUser = db
  .update(users)
  .set({
    name: "New Name"
  })
  .where(eq(users.id, userId))
  .returning({
    id: users.id,
    name: users.name
  })
```

### 6.4 Delete

```ts
const deleteUser = db
  .delete(users)
  .where(eq(users.id, userId))
  .returning({
    id: users.id
  })
```

### 6.5 Cardinality methods

Thor should provide different execution methods with different runtime contracts and different Effect error types.

```ts
query.all()
query.one()
query.maybeOne()
query.run()
query.stream()
```

Expected behavior:

| Method | Return | Extra errors |
|---|---|---|
| `.all()` | `ReadonlyArray<A>` | none beyond query/db/decode errors |
| `.one()` | `A` | `NotFoundError`, `TooManyRowsError` |
| `.maybeOne()` | `Option<A>` | `TooManyRowsError` |
| `.run()` | command result | command/db errors |
| `.stream()` | stream of rows | streaming/db/decode errors |

---

## 7. Query IR

The IR should benefit Effect at compile time and runtime.

### 7.1 Dual IR

Thor should model two IR layers:

```txt
Type-level IR
  → result type, error type, requirements, capabilities, table scope, params

Runtime IR
  → AST, guards, capabilities, decoders, annotations, tracing, compilation
```

### 7.2 Conceptual type shape

A query should conceptually carry:

```ts
QueryIR<
  Output,
  Error,
  Requirements,
  Capabilities,
  Scope,
  Cardinality,
  Params
>
```

A possible internal shape:

```ts
interface Query<
  A,
  E,
  R,
  Caps,
  Scope,
  Card,
  Params
> {
  readonly ir: RuntimeQueryIR

  all(): Effect.Effect<ReadonlyArray<A>, E, R>

  one(): Effect.Effect<
    A,
    E | NotFoundError | TooManyRowsError,
    R
  >

  maybeOne(): Effect.Effect<
    Option.Option<A>,
    E | TooManyRowsError,
    R
  >
}
```

### 7.3 Type-level IR responsibilities

Type-level IR should track:

```txt
- result type
- error type
- required Effect services
- required database capabilities
- visible table scope
- cardinality
- query parameter shape
```

This enables:

```txt
- selected result inference
- insert/update shape inference
- table scope safety
- generated column safety
- dialect-specific capability typing
- one/maybeOne error differences
- transaction-only requirement typing
```

### 7.4 Runtime IR responsibilities

Runtime IR should carry:

```txt
- query AST
- schema references
- selected fields
- expressions
- parameters
- required capabilities
- output decoder
- cardinality
- table names
- annotations
- tracing metadata
- cache key metadata
```

A possible base node:

```ts
interface BaseNode {
  readonly id: string
  readonly kind: string
  readonly capabilities: CapabilityBits
  readonly annotations: QueryAnnotations
}
```

Annotations:

```ts
interface QueryAnnotations {
  readonly operationName?: string
  readonly tableNames: ReadonlyArray<string>
  readonly estimatedCardinality?: "zero" | "one" | "many"
  readonly idempotency?: "idempotent" | "non-idempotent" | "unknown"
  readonly cacheKey?: string
  readonly tracing?: {
    readonly spanName: string
    readonly attributes: Record<string, string | number | boolean>
  }
}
```

### 7.5 Runtime pipeline

Every executed query should pass through:

```txt
QueryIR
  ↓
Normalize
  ↓
Guard
  ↓
Capability check
  ↓
Optimize
  ↓
Compile
  ↓
Prepare/cache
  ↓
Execute
  ↓
Decode
  ↓
Return Effect result
```

### 7.6 Inspectability

Queries should be inspectable.

```ts
query.inspect()
query.toSql(PostgresDialect)
query.requiredCapabilities()
query.explain()
query.decodeUnknownRows(rows)
```

Example:

```ts
q.inspect()
```

Could return:

```ts
{
  kind: "Select",
  tables: ["users"],
  params: ["email"],
  capabilities: [],
  cardinality: "many",
  output: {
    id: "uuid"
  }
}
```

---

## 8. Guards

Thor's guards must be central.

Guard types:

```txt
- schema guards
- query construction guards
- capability guards
- execution guards
- migration guards
- routine guards
```

### 8.1 Query guards

Examples:

| Guard | Example |
|---|---|
| Table scope | Cannot reference table not present in query scope |
| Aggregation scope | Non-aggregated columns require `groupBy` |
| Join scope | Join condition can reference only visible tables |
| Insert shape | Insert values must match insertable columns |
| Update shape | Cannot update generated/readonly columns |
| Returning support | `returning()` requires dialect capability |
| Pagination | Dialect-specific limit/offset rules |

### 8.2 Execution guards

Execution guards include:

| Guard | Purpose |
|---|---|
| Connection scope guard | Query cannot run outside live `Database` service |
| Transaction scope guard | Nested transactions require savepoint support |
| Timeout guard | Query respects Effect interruption |
| Decode guard | Rows decode through declared codecs |
| Row-count guard | `.one()` fails if 0 or >1 rows |
| Constraint guard | SQL constraint errors are normalized |
| Retry guard | Unsafe operations are not retried silently |

### 8.3 Migration guards

Migration guard categories:

| Operation | Default behavior |
|---|---|
| Drop table | Block unless explicitly allowed |
| Drop column | Block unless explicitly allowed |
| Narrow column type | Block unless explicitly unsafe |
| Add non-null column without default | Block unless table is empty or backfilled |
| Rename detection uncertainty | Warn and require confirmation |
| Irreversible migration | Require explicit marker |
| Raw SQL | Mark as unchecked |
| Dialect-unsafe DDL | Block via capability matrix |

---

## 9. Capability Matrix

Capabilities are executable metadata.

They must drive:

```txt
- query validation
- SQL compilation
- migration planning
- routine support
- transaction behavior
- streaming support
- testing
- benchmark classification
```

### 9.1 Capability status

```ts
type CapabilityStatus =
  | "native"
  | "emulated"
  | "unsupported"
  | "unknown"
```

### 9.2 Capability matrix

```ts
interface CapabilityMatrix {
  readonly dialect: DialectId
  readonly capabilities: Record<Capability, CapabilityStatus>
}
```

### 9.3 Example capabilities

```ts
type Capability =
  | "insert.returning"
  | "update.returning"
  | "delete.returning"
  | "insert.onConflict"
  | "insert.onDuplicateKey"

  | "select.cte"
  | "select.recursiveCte"
  | "select.windowFunctions"
  | "select.lateralJoin"
  | "select.forUpdate"

  | "transaction.savepoints"
  | "transaction.isolationLevel"

  | "schema.json"
  | "schema.array"
  | "schema.enum"
  | "schema.generatedColumns"
  | "schema.identityColumns"

  | "query.streaming"
  | "query.preparedStatements"

  | "routine.functionCall"
  | "routine.procedureCall"
  | "routine.tableValuedFunction"
  | "routine.namedArguments"
  | "routine.outParameters"
  | "routine.overloading"
  | "routine.variadicArguments"
  | "routine.defaultArguments"
  | "routine.schemaQualifiedName"
  | "routine.extensionRequired"

  | "migration.lock.advisory"
  | "migration.lock.table"
  | "migration.transactionalDdl"
  | "migration.rollbackDdl"
```

### 9.4 Postgres example

```ts
const PostgresCapabilities = defineCapabilities("postgres", {
  "insert.returning": "native",
  "update.returning": "native",
  "delete.returning": "native",

  "insert.onConflict": "native",
  "insert.onDuplicateKey": "unsupported",

  "select.cte": "native",
  "select.recursiveCte": "native",
  "select.windowFunctions": "native",
  "select.lateralJoin": "native",
  "select.forUpdate": "native",

  "transaction.savepoints": "native",
  "transaction.isolationLevel": "native",

  "schema.json": "native",
  "schema.array": "native",
  "schema.enum": "native",
  "schema.generatedColumns": "native",
  "schema.identityColumns": "native",

  "query.streaming": "native",
  "query.preparedStatements": "native",

  "routine.functionCall": "native",
  "routine.procedureCall": "native",
  "routine.tableValuedFunction": "native",
  "routine.namedArguments": "native",
  "routine.outParameters": "native",
  "routine.overloading": "native",
  "routine.variadicArguments": "native",
  "routine.defaultArguments": "native",
  "routine.schemaQualifiedName": "native",
  "routine.extensionRequired": "native",

  "migration.lock.advisory": "native",
  "migration.lock.table": "emulated",
  "migration.transactionalDdl": "native",
  "migration.rollbackDdl": "native"
})
```

---

## 10. Error Model

Thor errors should be tagged and typed.

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
  | GuardError
  | RoutineError
```

Example:

```ts
class CapabilityError {
  readonly _tag = "CapabilityError"

  constructor(
    readonly capability: Capability,
    readonly dialect: DialectId,
    readonly message: string
  ) {}
}
```

Example catch:

```ts
program.pipe(
  Effect.catchTag("ConstraintError", handleConstraint),
  Effect.catchTag("DecodeError", handleDecode)
)
```

The toolkit should avoid generic exceptions where a meaningful tagged error can exist.

---

## 11. Transactions

Transactions must be Effect-native.

Example:

```ts
const program = db.transaction((tx) =>
  Effect.gen(function* () {
    yield* tx.insert(users).values(input).run()
    return yield* tx.select().from(users).all()
  })
)
```

Rules:

```txt
- successful transaction commits
- failed transaction rolls back
- interrupted transaction rolls back
- nested transaction uses savepoints if supported
- nested transaction fails if savepoints unsupported
- transaction-scoped query cannot escape scope
- concurrent transactions must not share connection state incorrectly
```

Transaction capability checks:

```txt
transaction.savepoints
transaction.isolationLevel
migration.transactionalDdl
migration.rollbackDdl
```

---

## 12. Functions, Procedures, and Routines

Databases that support functions/procedures should be supported safely.

Core distinction:

```txt
Functions = expressions
Procedures = executable commands/effects
```

### 12.1 Functions

Function calls can be used inside SQL expressions.

Example:

```ts
db
  .select({
    id: users.id,
    lowerEmail: pg.fn.lower(users.email)
  })
  .from(users)
```

User-defined function:

```ts
const similarity = pg.defineFunction("similarity", {
  args: [pg.text(), pg.text()],
  returns: pg.real(),
  volatility: "stable",
  requires: ["extension.pg_trgm"]
})
```

Usage:

```ts
db
  .select({
    id: users.id,
    score: similarity(users.name, param("query", Schema.String))
  })
  .from(users)
  .orderBy(desc(similarity(users.name, param("query", Schema.String))))
```

### 12.2 Function metadata

Functions must carry:

```txt
- name
- schema
- argument types
- return type
- volatility
- nullability
- capabilities
- required extensions
- safety metadata
```

Volatility:

```ts
type RoutineVolatility =
  | "immutable"
  | "stable"
  | "volatile"
```

Volatility affects optimization and retry behavior.

Thor may deduplicate or normalize immutable expressions.

Thor must not reorder/deduplicate volatile expressions like `random()`.

### 12.3 Function IR

```ts
type FunctionCallNode = {
  readonly _tag: "FunctionCall"
  readonly name: RoutineName
  readonly args: ReadonlyArray<ExprNode>
  readonly returnType: ColumnType
  readonly volatility: RoutineVolatility
  readonly capabilities: CapabilityBits
  readonly annotations: {
    readonly schema?: string
    readonly sideEffects: boolean
    readonly safeForPreparedStatement: boolean
  }
}
```

### 12.4 Procedure calls

Procedures execute through Effect.

Example:

```ts
const closeExpiredSessions = pg.defineProcedure("close_expired_sessions", {
  args: {
    before: pg.timestamp()
  },

  returns: pg.object({
    closedCount: pg.integer()
  }),

  effects: {
    mutates: ["sessions"],
    idempotency: "idempotent",
    requiresTransaction: false
  }
})
```

Usage:

```ts
yield* db
  .procedure(closeExpiredSessions)
  .call({ before: new Date() })
```

Type conceptually:

```ts
Effect.Effect<
  { closedCount: number },
  ProcedureError | DecodeError | DriverError,
  Database
>
```

### 12.5 Procedure IR

```ts
type ProcedureCallNode = {
  readonly _tag: "ProcedureCall"
  readonly name: RoutineName
  readonly args: Record<string, ParamNode>

  readonly returns:
    | { readonly kind: "none" }
    | { readonly kind: "outParams"; readonly decoder: Decoder<unknown> }
    | { readonly kind: "rows"; readonly decoder: RowDecoder<unknown> }

  readonly effects: {
    readonly mutates: ReadonlyArray<TableName>
    readonly idempotency: "idempotent" | "non-idempotent" | "unknown"
    readonly requiresTransaction: boolean
  }

  readonly capabilities: CapabilityBits
}
```

### 12.6 Table-valued functions

Table-valued functions should be usable in `from`.

```ts
const searchUsers = pg.defineTableFunction("search_users", {
  args: {
    query: pg.text()
  },

  returns: {
    id: pg.uuid(),
    email: pg.text(),
    rank: pg.real()
  }
})

const s = searchUsers({ query: param("query", Schema.String) }).as("s")

db
  .select({
    id: s.id,
    email: s.email,
    rank: s.rank
  })
  .from(s)
  .orderBy(desc(s.rank))
```

### 12.7 Aggregate and window functions

Thor must distinguish:

```txt
ScalarFunctionCall
AggregateFunctionCall
WindowFunctionCall
TableFunctionCall
ProcedureCall
```

Aggregate functions require group guards.

Window functions require window capability guards.

Example:

```ts
pg.fn
  .rowNumber()
  .over({
    partitionBy: [posts.userId],
    orderBy: [desc(posts.createdAt)]
  })
```

### 12.8 Unsafe routine escape hatch

Dynamic routine names are unsafe.

Safe default:

```ts
defineFunction("public.normalize_email", ...)
```

Unsafe escape hatch:

```ts
unsafeFunction("dynamic_function_name", {
  args: [pg.text()],
  returns: pg.integer()
})
```

Unsafe routine calls should be annotated in the IR.

---

## 13. Migrations

Thor must support both manual migrations and automatic migrations.

Migration engine package surface lives under:

```txt
@gilvandovieira/thor/migrate
```

CLI package:

```txt
@gilvandovieira/cli
```

### 13.1 Migration modes

```txt
Manual migration mode
  Developer creates/edit/reviews migration files explicitly.

Programmatic migration mode
  App/test/tooling computes, validates, and applies migrations through Effect.

Automatic generation mode
  CLI diffs current schema IR against previous snapshot and generates migration.
```

All modes must use the same migration IR internally.

### 13.2 CLI commands

The CLI should support:

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
thor snapshot
thor pull
```

Command meanings:

| Command | Purpose |
|---|---|
| `init` | Create config, migrations folder, journal table |
| `create <name>` | Create an empty/manual migration |
| `generate <name>` | Diff current schema vs previous snapshot |
| `check` | Validate schema, migration order, destructive operations |
| `status` | Show applied/pending migrations |
| `up` | Apply pending migrations |
| `down` | Roll back last migration if reversible |
| `redo` | Down then up last migration |
| `drift` | Compare database state vs expected schema |
| `snapshot` | Write schema snapshot without migration |
| `pull` | Introspect live DB into schema/snapshot |

### 13.3 Manual migration file

```ts
import { defineMigration, sql } from "@gilvandovieira/thor/migrate"

export default defineMigration({
  id: "202607091430_add_users_table",
  name: "add_users_table",

  up: sql`
    create table users (
      id uuid primary key,
      email text not null unique,
      name text not null,
      created_at timestamptz not null default now()
    );
  `,

  down: sql`
    drop table users;
  `
})
```

### 13.4 Effect migration file

```ts
import { Effect } from "effect"
import { defineMigration, sql } from "@gilvandovieira/thor/migrate"

export default defineMigration({
  id: "202607091430_backfill_user_names",
  name: "backfill_user_names",

  up: Effect.gen(function* () {
    yield* sql`update users set name = email where name is null`
  }),

  down: Effect.gen(function* () {
    yield* Effect.fail(
      new IrreversibleMigrationError("Cannot recover previous null names")
    )
  })
})
```

### 13.5 Automatic migration flow

```txt
Current schema code
  ↓
Schema IR
  ↓
Previous schema snapshot
  ↓
Migration diff
  ↓
Migration plan IR
  ↓
Guard checks
  ↓
SQL generation
  ↓
Migration file
```

### 13.6 Migration IR

```ts
type MigrationOperation =
  | CreateTableOp
  | DropTableOp
  | RenameTableOp
  | AddColumnOp
  | DropColumnOp
  | RenameColumnOp
  | AlterColumnTypeOp
  | SetNotNullOp
  | DropNotNullOp
  | AddIndexOp
  | DropIndexOp
  | AddForeignKeyOp
  | DropForeignKeyOp
  | CreateFunctionOp
  | DropFunctionOp
  | CreateProcedureOp
  | DropProcedureOp
  | CreateExtensionOp
  | DropExtensionOp
  | RawSqlOp
  | EffectOp
```

Example operation:

```ts
{
  _tag: "AddColumn",
  table: "users",
  column: {
    name: "display_name",
    type: "text",
    nullable: true
  },
  destructive: false,
  reversible: true,
  capabilities: ["ddl.alterTable.addColumn"]
}
```

### 13.7 Programmatic migration API

```ts
import { Migrator } from "@gilvandovieira/thor/migrate"

const program = Effect.gen(function* () {
  const migrator = yield* Migrator

  yield* migrator.check()
  yield* migrator.up()
})
```

Useful APIs:

```ts
Migrator.diff(currentSchema)
Migrator.plan(currentSchema)
Migrator.check()
Migrator.status()
Migrator.up()
Migrator.down()
Migrator.drift()
Migrator.apply(plan)
```

### 13.8 Auto-migration policies

Auto-migration must be policy controlled.

```ts
type AutoMigrationPolicy =
  | "disabled"
  | "validate-only"
  | "safe-only"
  | "allow-destructive"
```

Defaults:

```txt
development: safe-only may be acceptable
test: reset/up may be acceptable
production: disabled or validate-only by default
```

Thor must never silently drop or destructively mutate production schema on app boot.

### 13.9 Migration journal

Thor should maintain a journal table:

```sql
create table _thor_migrations (
  id text primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null,
  execution_time_ms integer not null
);
```

Checksum mismatch must be a hard error by default.

### 13.10 Migration snapshots

Generated migrations should include snapshots:

```txt
migrations/
  202607091445_add_display_name_to_users.ts
  meta/
    202607091445_snapshot.json
    journal.json
```

Snapshots provide:

```txt
- stable diffs
- no dependence on live DB
- drift detection
- reviewable history
- reproducible generation
```

### 13.11 Migration locks

Migration execution must acquire a lock.

Capabilities:

```txt
migration.lock.advisory
migration.lock.table
```

Postgres should use advisory locks.

Fallback may use lock tables.

---

## 14. Testing

Testing is a first-class part of Thor.

Thor should provide:

```txt
@gilvandovieira/thor/testing
```

### 14.1 Testing thesis

```txt
Every query, schema, guard, capability rule, routine, migration,
and runtime behavior must be testable without a real database —
and then contract-tested against real dialects.
```

### 14.2 Testing tools

Thor testing should include:

```txt
FakeDatabaseLayer
FakeDriverLayer
SqlSnapshot
CapabilityMatrixTest
MigrationTestHarness
TransactionTestHarness
QueryArbitrary
expectSql
expectQuery
expectCapabilities
expectGuardFailure
expectDecodeFailure
makeDialectContractSuite
```

### 14.3 Testing pyramid

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
```

### 14.4 Type tests

Thor must test compile-time behavior.

Examples:

```ts
expectTypeOf(
  db.select({ id: users.id }).from(users).all()
).toEqualTypeOf<
  Effect.Effect<ReadonlyArray<{ id: string }>, DbError, Database>
>()
```

Negative tests:

```ts
// @ts-expect-error posts is not in query scope
db.select({ id: posts.id }).from(users)
```

Type tests should cover:

```txt
- selected result inference
- insert shape inference
- update shape inference
- nullable/default/generated column behavior
- table scope safety
- join scope safety
- returning() capability accumulation
- one() / maybeOne() error differences
- transaction-only APIs requiring Transaction
- dialect-specific API availability
```

### 14.5 IR tests

Example:

```ts
const q = db
  .select({ id: users.id, email: users.email })
  .from(users)
  .where(eq(users.email, param("email", Schema.String)))

expect(q.inspect()).toEqual({
  kind: "Select",
  tables: ["users"],
  params: ["email"],
  cardinality: "many",
  capabilities: []
})
```

### 14.6 Guard tests

Guard tests must assert tagged errors.

Example cases:

```txt
- invalid default type
- duplicate column names
- table out of scope
- aggregate without groupBy
- empty update set
- unsafe delete without where if safety mode enabled
- invalid returning selection
- one() returns NotFoundError on zero rows
- one() returns TooManyRowsError on many rows
- decode failure becomes DecodeError
```

### 14.7 Capability tests

Every feature should declare capabilities.

Example:

```ts
expectQuery(
  db.insert(users).values(input).returning()
).toRequireCapabilities(["insert.returning"])
```

Unsupported capability should fail before execution.

### 14.8 Compiler snapshot tests

Snapshot should include:

```txt
- SQL text
- params
- param order
- selected aliases
- quoted identifiers
- capability requirements
- cache key
```

Example:

```ts
expectSql(q, PostgresDialect).toMatchInlineSnapshot()
```

### 14.9 Fake driver tests

Fake driver tests should validate:

```txt
- SQL was compiled
- params were bound
- decoder was called
- cardinality was enforced
- errors were mapped correctly
- interruption released resources
- transaction rollback happened on failure
```

### 14.10 Real dialect contract tests

Every dialect adapter must pass a shared contract suite.

Example:

```ts
describeDialect("postgres", PostgresLiveLayer)
```

Contract tests:

```txt
- create table
- insert
- insert returning
- select
- update
- update returning
- delete
- delete returning
- transaction commit
- transaction rollback
- nested transaction/savepoint
- constraint error mapping
- JSON column behavior
- date/timestamp codec behavior
- migration apply/revert
```


### 14.11 Full SQL feature matrix tests

Thor must maintain a growing SQL feature test matrix that exercises the public query API from simple SQL to advanced SQL. These tests must run at multiple levels:

```txt
Unit level:
  Type inference
  IR shape
  guards
  required capabilities
  compiler snapshots

Fake execution level:
  bound params
  cardinality
  decoding
  typed errors
  transaction behavior

Real integration level:
  behavior against real dialects through Effect Layers
```

The feature matrix should be capability-aware. For each feature and dialect:

```txt
native capability:
  feature must compile and execute correctly

emulated capability:
  feature must fail unless emulation is explicitly enabled;
  when enabled, emulated behavior must pass contract tests

unsupported capability:
  feature must fail with CapabilityError before execution

unknown capability:
  feature must fail conservatively
```

Minimum SQL feature suites:

```txt
Level 1: Basic DML
  - select all
  - select projection
  - where equality
  - where and/or/not
  - order by asc/desc
  - limit/offset
  - insert one row
  - insert many rows
  - update with where
  - delete with where

Level 2: Typed SQL semantics
  - nullable columns
  - default columns
  - generated/readonly columns
  - aliases
  - params
  - raw SQL fragments with safe binding
  - one()
  - maybeOne()
  - all()
  - run()

Level 3: Joins and subqueries
  - inner join
  - left join
  - right/full join where supported
  - self join with aliases
  - subquery in from
  - subquery in where
  - exists/not exists
  - in/not in

Level 4: Aggregation
  - count/sum/avg/min/max
  - group by
  - having
  - aggregate plus non-aggregate guard failures
  - distinct
  - distinct on where supported

Level 5: Advanced selection
  - CTE
  - recursive CTE where supported
  - window functions
  - lateral joins where supported
  - set operations union/intersect/except where supported

Level 6: Dialect-specific data types
  - uuid
  - timestamp/date
  - json/jsonb where supported
  - arrays where supported
  - enums where supported
  - decimal/numeric
  - binary/blob

Level 7: Mutation features
  - returning where supported
  - upsert/on conflict where supported
  - on duplicate key where supported
  - delete returning where supported
  - update returning where supported
  - affected row count

Level 8: Transactions
  - commit
  - rollback on failure
  - rollback on interruption
  - nested transaction/savepoint where supported
  - isolation level where supported
  - transaction-scoped query cannot escape scope

Level 9: Routines
  - scalar functions
  - aggregate functions
  - window functions
  - table-valued functions where supported
  - procedures where supported
  - routine capability failures
  - routine decode failures

Level 10: Migrations and DDL
  - create table
  - alter table add/drop column
  - create/drop index
  - foreign keys
  - destructive migration blocking
  - drift detection
  - migration journal/checksum
```

The matrix should be represented as executable test definitions, not just prose.

Example shape:

```ts
defineSqlFeatureSuite({
  id: "select.basic.where",
  requires: [],
  build: (db, t) =>
    db
      .select({ id: t.users.id })
      .from(t.users)
      .where(eq(t.users.email, param("email", Schema.String))),
  assertSql: {
    postgres: `select "users"."id" from "users" where "users"."email" = $1`,
    sqlite: `select "users"."id" from "users" where "users"."email" = ?`,
    mysql: "select `users`.`id` from `users` where `users`.`email` = ?"
  },
  assertResult: [{ id: "user_1" }]
})
```

Integration tests should use Thor's Effect Layers for database connections. They should not manually manage connections except for low-level test harness setup.

### 14.12 Property and fuzz tests

Thor should include property-based tests for IR and compiler invariants.

Examples:

```txt
- normalize(normalize(query)) equals normalize(query)
- compile never emits unbound params
- param order is deterministic
- unsupported capabilities always fail before driver execution
- cache keys are stable for equal query shapes
- cache keys differ for meaningfully different query shapes
- optimization preserves required capabilities
- optimization never reorders volatile function calls
```

Property tests should especially target advanced SQL combinations because manually written examples will miss edge cases.

### 14.13 Migration tests

Migration testing should cover:

```txt
- generated migration matches expected IR
- generated SQL matches snapshot
- destructive changes are blocked
- irreversible migrations are marked
- checksum mismatch fails
- migration lock is acquired/released
- failed migration rolls back when supported
- drift detection works
```

---

## 15. Benchmarks

Benchmarks are part of the project from day one.

### 15.1 Benchmark thesis

```txt
If query building, IR, guards, or compilation become the worst part
of an I/O-heavy database application, the design is wrong.
```

Database I/O may be slow.

Thor's abstraction should not be the reason it is slow.

### 15.2 Benchmark package/subpath

For v0, benchmarks may live under:

```txt
@gilvandovieira/thor/bench
```

They may become their own package later if they grow.

### 15.3 Benchmark layers

Benchmarks should measure the pipeline separately:

```txt
Schema DSL
  ↓
Query builder
  ↓
IR construction
  ↓
IR normalization
  ↓
Guard checks
  ↓
Capability checks
  ↓
SQL compilation
  ↓
Prepared statement cache lookup
  ↓
Driver execution
  ↓
Row decoding
  ↓
Effect runtime overhead
```

### 15.4 Benchmark categories

```txt
bench:build
bench:ir
bench:guard
bench:capability
bench:compile
bench:decode
bench:effect
bench:integration
bench:migrate
```

### 15.5 Query construction benchmarks

Cases:

```txt
- simple select
- select with where
- select with joins
- select with nested and/or
- insert one row
- insert many rows
- update with where
- delete with where
- CTE query
- query with params
```

### 15.6 IR benchmarks

Cases:

```txt
- inspect
- normalize
- capability accumulation
- structural hash
- large selection
- many joins
- large insert batch
```

### 15.7 Compiler benchmarks

Cases:

```txt
- simple select
- join select
- CTE
- insert returning
- update returning
- batch insert
- complex predicates
- alias-heavy selection
```

Measure:

```txt
- compile time
- allocations
- string building behavior
- parameter ordering
- cache key generation
```

### 15.8 Decode benchmarks

Cases:

```txt
- 1 row, 3 columns
- 1 row, 20 columns
- 100 rows
- 1,000 rows
- JSON column
- timestamp codec
- nullable fields
- branded IDs
```

Compare modes:

```txt
- no decode / trusted rows
- lightweight decoder
- Effect Schema decoder
- strict decode with detailed errors
```

### 15.9 Effect overhead benchmarks

Measure:

```txt
- all()
- one()
- maybeOne()
- transaction success
- transaction rollback
- Effect.gen execution boundary
- Layer provision
- scoped connection acquisition
```

### 15.10 Baselines

Compare against:

```txt
- raw handwritten SQL
- Drizzle-like query builder
- Thor without execution
- Thor with Effect execution
```

### 15.11 Benchmark-driven design constraints

```txt
- builder must be pure
- avoid deep cloning
- IR should be compact
- capability checks should be cheap
- compilation should be cacheable
- params should be separated from query shape
- repeated query shapes should have stable cache keys
```

Possible optimization:

```ts
type CapabilityBits = number | bigint
```

Public API can expose readable names while internals use bitsets.


### 15.12 Hot-path performance targets

Thor should set aggressive performance targets for its own overhead. These targets apply to Thor code only, not database I/O, network time, driver time, operating system scheduling, or real database execution.

The aspirational target for hot cached paths is:

```txt
Thor hot-path overhead over a raw driver call:
  target: 1–2 microseconds
  ideal: sub-microsecond where realistic
```

This is a target, not a promise. The exact number must be validated per runtime, CPU, driver, and benchmark harness. Cold paths and rich safety paths are allowed to cost more.

Budget categories:

```txt
Static/precompiled query handle creation:
  may be higher; usually paid at module load or application startup

Hot cached query execution path:
  should target 1–2us Thor overhead over the driver in synthetic/fake-driver benchmarks

Simple query builder construction:
  should aim for sub-microsecond to low-microsecond cost for small queries

Cold build + guard + capability + compile:
  should be measured and optimized, but is not the main hot-path budget

Integration tests against real databases:
  must not use microsecond budgets because I/O dominates
```

The strictest benchmarks should run against a fake/no-op driver and in-memory SQLite because networked Postgres can hide toolkit overhead.

### 15.13 Performance modes

Thor should support different execution/performance modes without changing the public query API shape.

```txt
safe mode:
  full guards, strict decode, full capability checks, detailed errors

trusted mode:
  prevalidated query shape, reduced runtime guards, normal driver errors

unsafe/hot mode:
  precompiled query, trusted input shape, minimal runtime checks, explicit opt-in
```

Unsafe/hot mode must never be the default. It exists for measured hot paths where the user accepts reduced runtime safety.

Possible API direction:

```ts
const findUserByEmail = db
  .select({ id: users.id, email: users.email })
  .from(users)
  .where(eq(users.email, param("email", Schema.String)))
  .prepare("find_user_by_email")

yield* findUserByEmail.one({ email })
```

Prepared handles should separate query shape from values and skip repeated builder/normalization/compile work.

### 15.14 Required optimization strategies

Thor should use every reasonable optimization strategy that preserves correctness and debuggability.

Required strategies:

```txt
- memoize normalized IR by query identity where safe
- memoize structural hashes
- memoize required capability sets
- precompute capability bitsets
- precompile stable query shapes
- cache compiled SQL by dialect + query shape
- cache prepared statement metadata
- separate query shape from runtime values
- avoid deep cloning in fluent builders
- avoid Effect in pure builder/IR/compiler hot paths
- avoid allocating per column during execution
- avoid repeated decoder construction
- reuse column/table metadata objects
- intern stable identifier/alias strings where useful
```

Capability checks may expose readable names publicly, but internals should use compact representations:

```ts
type CapabilityBits = number | bigint
```

Compiled query cache key should include:

```txt
- dialect id
- dialect version/capability profile
- query structural hash
- selected execution mode
- decode mode where relevant
```

It should not include parameter values.

### 15.15 Precompilation and static query handles

Thor should encourage precompiled query handles for hot application paths.

Example:

```ts
export const FindUserByEmail = db
  .select({
    id: users.id,
    email: users.email,
    name: users.name
  })
  .from(users)
  .where(eq(users.email, param("email", Schema.String)))
  .prepare("FindUserByEmail")
```

Runtime use:

```ts
const user = yield* FindUserByEmail.one({ email })
```

A prepared handle should precompute as much as possible:

```txt
- normalized IR
- guard result
- required capabilities
- structural hash
- compiled SQL per dialect where dialect is known
- param order
- decoder plan
- tracing metadata
```

If the dialect is only known at runtime, the handle should compile once per dialect and then cache.

### 15.16 Performance gates

Benchmark gates should be introduced gradually.

Early v0:

```txt
- collect baselines
- do not fail CI on small variance
- fail only on catastrophic regressions
```

After baselines stabilize:

```txt
- fail CI when hot-path benchmarks regress beyond a configured threshold
- keep thresholds generous enough for CI noise
- require local benchmark runs before merging performance-sensitive changes
```

Candidate gates:

```txt
- hot cached no-op query overhead must stay within budget
- simple query build must not regress significantly
- compile cache hit must be much faster than cold compile
- capability check must remain negligible relative to compile
- unsupported capability must fail before driver execution
```

### 15.17 Performance correctness rules

Performance optimizations must not break semantic safety.

```txt
- never cache parameter values inside compiled query shape
- never optimize away volatile function calls
- never dedupe side-effecting routines
- never bypass capability checks unless the query handle records a prior successful check for the same dialect profile
- never reuse a transaction-bound prepared handle outside its transaction scope
- never allow unsafe/hot mode without explicit user opt-in
```

---

## 16. Prepared Statements and Query Caching

Thor should separate query shape from query values.

Example:

```txt
Query shape:
  select users where email = ?

Query values:
  email = "lucas@example.com"
```

Compiled query shape:

```ts
type CompiledQuery = {
  sql: string
  paramOrder: ReadonlyArray<ParamRef>
  cacheKey: string
}
```

Execution binds values separately.

This enables:

```txt
- stable prepared statement caching
- better benchmarks
- safer params
- less repeated compilation
```

---

## 17. Observability

Runtime IR annotations should support logging, metrics, and tracing.

Relevant metadata:

```txt
- operation name
- table names
- query kind
- cardinality
- capability requirements
- cache hit/miss
- compile time
- execution time
- decode time
- row count
```

Thor should avoid logging sensitive parameter values by default.

---

## 18. Safety Invariants

### 18.1 Capability invariant

```txt
Every query, migration, and routine operation must declare required
capabilities in IR before compilation or execution. Unsupported
capabilities must fail before execution unless explicit emulation is enabled.
```

### 18.2 IR invariant

```txt
Every fluent database operation produces a typed IR. The typed IR improves
TypeScript inference before execution. The runtime IR improves validation,
compilation, decoding, observability, resource safety, and error typing
during execution.
```

### 18.3 Routine safety invariant

```txt
Database functions and procedures must be represented in the IR as
declared, typed routine references. Routine names are never interpolated
from unchecked strings. Function calls are expressions; procedure calls
are executable commands. Routine metadata must describe argument types,
return types, capabilities, volatility, side effects, idempotency, and
transaction requirements so the Effect runtime can enforce safe execution.
```

### 18.4 Migration invariant

```txt
The CLI and programmatic migration API must share the same schema IR,
migration planner, guards, capability checks, and executor. Manual
migrations and generated migrations are both represented as migration IR
before execution. Destructive, irreversible, dialect-unsafe, or drifted
migrations must be blocked unless explicitly approved by policy.
```

### 18.5 Testing invariant

```txt
Every schema feature, query feature, routine feature, dialect capability,
guard, compiler behavior, transaction behavior, and migration behavior must
be testable through pure IR tests, fake driver tests, and/or dialect contract
tests.
```


### 18.6 Integration testing invariant

```txt
Thor integration tests must provide real database services through Effect
Layers, not manually managed connections. Each dialect adapter must pass a
shared capability-aware contract suite. Test isolation must be explicit:
transaction-per-test, schema-per-worker, or database-per-suite depending on
the behavior being tested.
```

### 18.7 Runtime portability invariant

```txt
Thor must separate database dialect behavior from JavaScript runtime behavior.
A dialect adapter may have different driver implementations per runtime, but
must expose the same Thor Database service contract. Runtime support is valid
only when the adapter passes the shared contract suite under that runtime.
```

### 18.8 Hot-path performance invariant

```txt
Thor must make hot-path overhead measurable and intentionally small. Stable
query shapes should support memoization and precompilation. The target for
cached Thor overhead over a raw driver call is 1–2 microseconds, with
sub-microsecond overhead as an ideal for the smallest synthetic hot paths.
This target applies to Thor overhead only, not real database I/O.
```

### 18.9 Benchmark invariant

```txt
The toolkit must treat query construction, IR transformation, guarding,
capability checking, and SQL compilation as measurable hot paths. No feature
may add unbounded or hidden overhead to these paths. Every new query feature
must include benchmarks covering build cost, IR size, compile cost,
capability-check cost, and execution overhead where applicable.
```

### 18.10 Effect boundary invariant

```txt
Effect should be used for execution boundaries, service requirements,
resource safety, errors, transactions, interruption, streaming, testing,
and migrations. Pure query construction and pure IR transformations should
remain pure unless there is a strong reason otherwise.
```

---

## 19. Initial Development Milestones

### Milestone 0: Repository and package skeleton

```txt
- create monorepo
- create @gilvandovieira/thor
- create @gilvandovieira/cli
- configure TypeScript
- configure tests
- configure benchmarks
- define exports
```

### Milestone 1: Core schema and IR

```txt
- define table DSL
- define column DSL
- generate select/insert/update types
- define Schema IR
- define Query IR
- define base errors
- define capability types
```

### Milestone 2: Query builder

```txt
- select
- insert
- update
- delete
- where predicates
- joins basic shape
- params
- returning
- cardinality methods
```

### Milestone 3: Guards and capabilities

```txt
- schema guards
- query guards
- capability checks
- Postgres capability matrix
- typed CapabilityError
```

### Milestone 4: Postgres compiler

```txt
- compile select
- compile insert
- compile update
- compile delete
- compile returning
- quote identifiers
- bind params
- generate cache keys
```

### Milestone 5: Effect execution

```txt
- Database service
- driver contract
- Postgres driver adapter
- all/one/maybeOne/run
- decode pipeline
- typed errors
```

### Milestone 6: Testing package/subpath

```txt
- FakeDriverLayer
- FakeDatabaseLayer
- expectSql
- expectQuery
- capability assertions
- guard assertions
- initial contract suite
- full SQL feature matrix suite
- capability-aware dialect expectations
- property/fuzz tests for IR and compiler invariants
```

### Milestone 7: Benchmarks

```txt
- build benchmarks
- IR benchmarks
- compile benchmarks
- decode benchmarks
- Effect execution benchmarks
- baseline comparisons
- fake/no-op driver hot-path benchmark
- cache hit vs cold compile benchmark
- prepared handle benchmark
- Node and Bun benchmark lanes
- initial 1–2us hot-path overhead target tracking
```

### Milestone 8: Migrations

```txt
- defineMigration
- manual migration files
- migration journal
- migration lock
- schema snapshot
- generate migration from diff
- thor create
- thor generate
- thor up
- thor status
- thor check
```

### Milestone 9: Routines

```txt
- defineFunction
- scalar functions
- aggregate functions
- window functions
- defineProcedure
- procedure execution
- table-valued functions
- routine capability checks
```

---

## 20. Non-goals for Early v0

Thor v0 should not try to solve everything.

Non-goals:

```txt
- replacing every ORM feature
- full relation graph loading
- model decorators
- entity manager identity map
- multi-dialect parity
- automatic production migrations without explicit policy
- cost-based SQL optimization
- raw SQL-first design
- hiding database dialect differences
```

Thor should expose dialect differences through capabilities rather than pretending every database behaves the same.

---

## 21. Final Project Statement

Thor Project is an Effect-native ORM/database toolkit initially published as:

```txt
@gilvandovieira/thor
@gilvandovieira/cli
```

It prefers a flat package structure with subpath modules inside the main package.

Thor's foundation is a typed and runtime IR that powers:

```txt
- fluent query building
- schema typing
- guards
- capability checks
- SQL compilation
- Effect execution
- row decoding
- safe routines
- safe migrations
- testing
- benchmarks
- tracing and observability
```

The project should be judged by four core questions:

```txt
1. Does the API feel ergonomic enough to use daily?
2. Does the IR make queries safer and more inspectable?
3. Does Effect improve runtime safety without infecting pure hot paths?
4. Do tests and benchmarks prove the abstraction is correct and cheap?
5. Do hot cached query paths stay near the 1–2us Thor-overhead target?
```

The guiding rule:

```txt
Database I/O may be slow.
Thor must not be the reason it is slow.
```
