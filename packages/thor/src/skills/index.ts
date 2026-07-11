/**
 * LLM skills (v1 spec §21). Machine- and human-readable guidance that teaches
 * agents to operate through Thor's declared APIs — schema DSL, query builder,
 * migration planner, capability matrix, testing helpers, benchmarks — rather than
 * raw SQL, and to check capabilities and never bypass safety guards unless
 * explicitly asked (§21.6).
 *
 * Skills are guidance; Thor's guards, capability checks, tests, and compilers
 * remain the source of truth (§21.1). Content lives here as strings so the
 * package is self-contained; `skillFiles()` renders the exportable file set that
 * the `thor skills export` command (Epic T) writes to disk.
 *
 * @module skills
 */

/** Version stamped into the manifest; tracks the skill content, not the package. */
export const SKILLS_VERSION = "1.0.0-draft"

/** A single authored skill. */
export interface Skill {
  /** Stable dotted id, e.g. `thor.query`. */
  readonly id: string
  /** File name used on export, e.g. `query.skill.md`. */
  readonly file: string
  /** Short human title. */
  readonly title: string
  /** One-line description used in the manifest. */
  readonly description: string
  /** Full skill markdown following the §21.3 shape. */
  readonly content: string
}

/**
 * Build one skill's markdown from its structured parts (§21.3 shape).
 *
 * @param parts - Structured skill sections.
 * @returns The rendered skill markdown.
 */
const skillMarkdown = (parts: {
  readonly title: string
  readonly goal: string
  readonly useWhen: ReadonlyArray<string>
  readonly checks: ReadonlyArray<string>
  readonly safe: ReadonlyArray<string>
  readonly unsafe: ReadonlyArray<string>
  readonly examples: string
  readonly verification: ReadonlyArray<string>
  readonly hardRule: string
}): string =>
  `# Thor Skill: ${parts.title}

## Goal

${parts.goal}

## Use When

${parts.useWhen.map((line) => `- ${line}`).join("\n")}

## Required Checks

${parts.checks.map((line) => `- ${line}`).join("\n")}

## Safe Patterns

${parts.safe.map((line) => `- ${line}`).join("\n")}

## Unsafe Patterns

${parts.unsafe.map((line) => `- ${line}`).join("\n")}

## Examples

${parts.examples}

## Verification

${parts.verification.map((line) => `- ${line}`).join("\n")}

## Hard Rule

${parts.hardRule}
`

/** The 10 required skills (§21.4), authored against Thor's real API. */
export const SKILLS: ReadonlyArray<Skill> = [
  {
    id: "thor.schema",
    file: "schema.skill.md",
    title: "Defining Schemas",
    description: "Define Thor schemas safely.",
    content: skillMarkdown({
      title: "Defining Schemas",
      goal: "Teach an agent to declare tables, columns, keys, and constraints with Thor's schema DSL so row types and migration DDL are inferred, not hand-written.",
      useWhen: [
        "The user models tables, columns, or relationships.",
        "The user needs Select/Insert/Update row types.",
        "The user adds foreign keys, indexes, or unique/generated columns."
      ],
      checks: [
        "Use `pg`/`sqlite`/`mysql` table builders; never hand-write row interfaces.",
        "Mark nullability with `.notNull()`/`.nullable()`; defaults with `.default*()`.",
        "Declare foreign keys with `column.references(() => other.col)` (deferred thunk; annotate self-references).",
        "Declare indexes/unique/check via table options; they flow into migration DDL.",
        "Check dialect capabilities before using generated columns or advanced types."
      ],
      safe: [
        "`pg.uuid(\"id\").primaryKey().defaultRandom()`",
        "`pg.text(\"email\").notNull().unique()`",
        "`authorId: pg.uuid(\"author_id\").notNull().references(() => authors.id, { onDelete: \"cascade\" })`",
        "Derive types: `type Row = Select<typeof table>`."
      ],
      unsafe: [
        "Hand-writing TS interfaces that duplicate the table shape.",
        "Adding dialect-specific column types without a capability check.",
        "Interpolating identifiers into names instead of using the DSL."
      ],
      examples: "```ts\nconst authors = pg.table(\"authors\", {\n  id: pg.uuid(\"id\").primaryKey().defaultRandom(),\n  name: pg.text(\"name\").notNull()\n})\nconst posts = pg.table(\"posts\", {\n  id: pg.uuid(\"id\").primaryKey().defaultRandom(),\n  authorId: pg.uuid(\"author_id\").notNull().references(() => authors.id),\n  createdAt: pg.timestamp(\"created_at\").notNull().defaultNow()\n})\n```",
      verification: [
        "Add compile-time type tests for `Select`/`Insert`/`Update`.",
        "Snapshot the `tableToCreateOp` DDL per dialect.",
        "Round-trip FK/index metadata through migration + introspection."
      ],
      hardRule: "Do not create schema constructs without checking dialect capabilities."
    })
  },
  {
    id: "thor.query",
    file: "query.skill.md",
    title: "Writing Queries",
    description: "Write Thor fluent SQL queries safely.",
    content: skillMarkdown({
      title: "Writing Queries",
      goal: "Teach an agent to build Thor fluent queries that stay pure until execution and never interpolate user input into SQL.",
      useWhen: [
        "The user asks for queries, repository functions, filtering, joins, sorting, pagination, or mutations."
      ],
      checks: [
        "Use schema-defined tables and columns; do not reference tables outside query scope.",
        "Use `param(name, Schema)` for every user-supplied value.",
        "Check dialect capability before advanced SQL (joins/CTE/window/upsert).",
        "Use `.one()` only when exactly one row is expected; `.maybeOne()` when absence is valid; `.all()` for many; `.run()` for writes.",
        "Compile a hot path with `.compile()`; bind values at `execute()` time."
      ],
      safe: [
        "`db.select({ id: users.id }).from(users).where(eq(users.email, param(\"email\", Schema.String)))`",
        "`db.insert(users).values({ email }).returning({ id: users.id }).one()`",
        "For trusted dynamic text, `unsafeSql(...)` marks the boundary explicitly."
      ],
      unsafe: [
        "String-concatenating user input into SQL or `unsafeSql`.",
        "Using `.one()` where zero or many rows are possible.",
        "Referencing a column from a table not in `from`/`join` scope."
      ],
      examples: "```ts\nconst FindByEmail = db\n  .select({ id: users.id, email: users.email })\n  .from(users)\n  .where(eq(users.email, param(\"email\", Schema.String)))\n  .one()\n  .compile()\n\nconst user = yield* FindByEmail.execute({ email })\n```",
      verification: [
        "Add type tests for the row shape.",
        "Add per-dialect SQL snapshot tests.",
        "Add integration tests when behavior depends on the dialect."
      ],
      hardRule: "Never interpolate user input into raw SQL. Use params and schema-backed values."
    })
  },
  {
    id: "thor.effect-execution",
    file: "effect-execution.skill.md",
    title: "Executing with Effect",
    description: "Run Thor queries as Effects with layers and transactions.",
    content: skillMarkdown({
      title: "Executing with Effect",
      goal: "Teach an agent that building a query is pure and only terminal methods produce an Effect requiring the `Database` service.",
      useWhen: [
        "The user runs queries, wires a database layer, uses transactions, or handles typed errors."
      ],
      checks: [
        "Terminal methods `all`/`one`/`maybeOne`/`run` return Effects requiring `Database`.",
        "Provide a `Database` via a Layer (`PostgresLayer`/`SQLiteLayer`/`MySQLLayer`/`FakeDatabaseLayer`).",
        "Wrap related writes in `db.transaction(...)`; nested calls use savepoints.",
        "Handle tagged errors with `Effect.catchTag`; do not swallow them.",
        "Provide a retry policy explicitly if retries are wanted."
      ],
      safe: [
        "`Effect.provide(program, PostgresScopedLayer({ acquire, release }))`",
        "`db.transaction(Effect.gen(function* () { ... }))`",
        "`withMode(layer, \"trusted\")` for validated hot paths."
      ],
      unsafe: [
        "Opening/closing raw client connections in userland.",
        "`withMode(layer, \"unsafe-hot\")` without an explicit opt-in reason.",
        "Catching all errors as untyped exceptions."
      ],
      examples: "```ts\nconst program = FindByEmail.execute({ email })\nEffect.runPromise(program.pipe(Effect.provide(DatabaseLive)))\n```",
      verification: [
        "Test error channels with `FakeDriver` failures.",
        "Test transaction commit/rollback and savepoint nesting.",
        "Assert resource acquire/release under interruption."
      ],
      hardRule: "Do not manually manage connections in userland unless building a driver adapter. Use Thor/Effect Layers."
    })
  },
  {
    id: "thor.migrations",
    file: "migrations.skill.md",
    title: "Migrations",
    description: "Create and review Thor migrations.",
    content: skillMarkdown({
      title: "Migrations",
      goal: "Teach an agent to author, plan, and review migrations with policies and expand/contract staging, never defaulting to destructive operations.",
      useWhen: [
        "The user changes the schema, backfills data, or reviews pending migrations."
      ],
      checks: [
        "Preview with `Migrator.diff`/`plan`/`dryRun` before applying.",
        "Set a `policy` (`safe-only` default); destructive ops need `allow-reviewed-destructive` + `reviewed: true`.",
        "Stage breaking changes with `planExpandContract` (expand → backfill → require → contract).",
        "Use `backfill(effect)` for typed data steps; give Effect steps a `revision`.",
        "Run drift detection (`Introspector.drift`) before migrating."
      ],
      safe: [
        "`MigratorLive({ schema, policy: \"safe-only\" })`",
        "`planExpandContract(\"rename_name\", { table, add, backfillSql, dropColumn })`",
        "`up: backfill(db.update(users).set({ ... }).run())` with a `revision`."
      ],
      unsafe: [
        "Generating `DropTable`/`DropColumn`/type-narrowing as a safe default.",
        "Applying a hand-built destructive plan without a reviewed policy.",
        "Editing an already-applied migration (checksum mismatch fails)."
      ],
      examples: "```ts\nconst plan = yield* migrator.plan(\"add_posts\")\nconst report = yield* migrator.dryRun()\nyield* migrator.up() // applies pending under policy\n```",
      verification: [
        "Snapshot generated DDL per dialect.",
        "Test policy gating (safe-only blocks destructive; reviewed allows it).",
        "Test concurrency/failure paths and checksum validation."
      ],
      hardRule: "Never generate destructive migrations as safe defaults. Drop table/drop column/type narrowing require explicit approval."
    })
  },
  {
    id: "thor.capabilities",
    file: "capabilities.skill.md",
    title: "Capabilities",
    description: "Check dialect and runtime capabilities before using features.",
    content: skillMarkdown({
      title: "Capabilities",
      goal: "Teach an agent to gate features on the dialect capability matrix and runtime capabilities, failing conservatively when support is missing.",
      useWhen: [
        "The user uses `RETURNING`, CTEs, window functions, upserts, or runtime-specific adapters."
      ],
      checks: [
        "Every capability is `native`, `emulated`, `unsupported`, or `unknown`.",
        "Guards fail with a tagged `CapabilityError` before the driver runs — do not catch and emulate.",
        "Runtime capabilities (Node/Bun/SQLite) gate adapter selection separately.",
        "Inspect required capabilities with `query.requiredCapabilities()`.",
        "`thor capabilities <dialect>` prints the authoritative matrix."
      ],
      safe: [
        "Check `requiredCapabilities()` and branch, or let the guard reject before execution.",
        "Allow emulation only via an explicit policy where it is correct."
      ],
      unsafe: [
        "Assuming `RETURNING` works on MySQL (it does not).",
        "Faking portability by silently rewriting unsupported features.",
        "Ignoring an `unknown` capability."
      ],
      examples: "```ts\n// MySQL rejects INSERT ... RETURNING before the driver:\nExpect a CapabilityError, not a silent workaround.\n```",
      verification: [
        "Assert `CapabilityError` before the driver for unsupported features.",
        "Run the capability-aware dialect contract suite.",
        "Regenerate and diff the capability summary."
      ],
      hardRule: "If a capability is unsupported or unknown, fail conservatively. Do not fake portability."
    })
  },
  {
    id: "thor.routines",
    file: "routines.skill.md",
    title: "Routines",
    description: "Use declared functions, aggregates, table functions, and procedures.",
    content: skillMarkdown({
      title: "Routines",
      goal: "Teach an agent that functions are expressions and procedures are Effect operations, with volatility, transaction, and safety metadata honored.",
      useWhen: [
        "The user calls database functions, aggregates, window functions, table functions, or stored procedures."
      ],
      checks: [
        "`defineFunction`/`defineAggregateFunction` produce expressions usable in select/where; apply windows with `.over({ partitionBy, orderBy })`.",
        "`defineTableFunction(...).call(args, alias)` is a relation source for `from`.",
        "`defineProcedure(...).call(args).run()` is an Effect; a `requiresTransaction` procedure fails outside `db.transaction`.",
        "Routine names are declared and interned; never interpolated.",
        "Declare volatility so prepared-statement/retry behavior is correct."
      ],
      safe: [
        "`db.select({ total: sumScore(users.score).over({ partitionBy: [users.teamId] }) }).from(users)`",
        "`db.transaction(cleanup.call({ before }).run())` for a `requiresTransaction` procedure."
      ],
      unsafe: [
        "Building a routine name from user input.",
        "Calling a `requiresTransaction` procedure outside a transaction.",
        "Treating a procedure like a scalar function (or vice versa)."
      ],
      examples: "```ts\nconst lower = defineFunction(\"lower\", { args: [{ dataType: \"text\", codec: Schema.String }], returns: { dataType: \"text\", codec: Schema.String }, volatility: \"immutable\" })\ndb.select({ email: lower(users.email) }).from(users)\n```",
      verification: [
        "Snapshot routine-call SQL and required capabilities.",
        "Test aggregation-scope and window guards.",
        "Test procedure transaction-requirement failures."
      ],
      hardRule: "Functions are expressions. Procedures are Effect operations. Do not collapse them into the same API."
    })
  },
  {
    id: "thor.testing",
    file: "testing.skill.md",
    title: "Testing",
    description: "Test Thor features at the correct layer.",
    content: skillMarkdown({
      title: "Testing",
      goal: "Teach an agent to test each feature at the right layer — types, IR, guards, SQL snapshots, fake-driver execution, and integration.",
      useWhen: [
        "The user adds or changes a query, schema, migration, dialect, or routine feature."
      ],
      checks: [
        "Add type tests for inferred row/param shapes.",
        "Add SQL snapshot tests per dialect via `.toSql(dialect)`.",
        "Use `FakeDriver`/`FakeDatabaseLayer` for zero-I/O execution and error paths.",
        "Run the capability-aware dialect contract suite for adapters.",
        "Add migration concurrency/failure tests where relevant."
      ],
      safe: [
        "`FakeDatabaseLayer(new FakeDriver().enqueue({ rows: [...] }))`",
        "`makeDialectContractSuite(...)` for every dialect adapter.",
        "Property tests with a deterministic `fast-check` seed."
      ],
      unsafe: [
        "Relying only on live integration tests.",
        "Skipping the capability-error branch for unsupported features.",
        "Non-deterministic fuzz seeds."
      ],
      examples: "```ts\nconst driver = new FakeDriver().enqueue({ rows: [{ id: \"u1\" }] })\nawait Effect.runPromise(Effect.provide(query.all(), FakeDatabaseLayer(driver)))\n```",
      verification: [
        "Ensure unit + fake-execution + integration coverage for new features.",
        "Assert typed errors, not thrown exceptions.",
        "Keep SQL snapshots current across dialects."
      ],
      hardRule: "Every new feature needs tests at the correct layer. Do not rely only on integration tests."
    })
  },
  {
    id: "thor.dialects",
    file: "dialects.skill.md",
    title: "Dialects",
    description: "Keep dialect-specific behavior in dialect adapters.",
    content: skillMarkdown({
      title: "Dialects",
      goal: "Teach an agent to keep the shared core dialect-neutral and route backend differences through PostgreSQL/SQLite/MySQL adapters.",
      useWhen: [
        "The user targets a specific backend or hits a dialect difference in SQL, migrations, or routines."
      ],
      checks: [
        "The IR, guards, and cache keys are dialect-neutral; only the compiler renders SQL.",
        "Placeholders, quoting, comparison, and capability matrices differ per dialect.",
        "MySQL is an explicitly partial target (no `RETURNING`, non-transactional DDL).",
        "SQLite type affinity collapses logical types; introspection type-diff is lossy.",
        "Compile against a dialect without executing via `.toSql(dialect)`."
      ],
      safe: [
        "Add backend behavior in the dialect adapter, not the core.",
        "Use `withMode`/layers to switch backends without changing the query."
      ],
      unsafe: [
        "Writing Postgres-shaped assumptions into core abstractions.",
        "Assuming MySQL supports `RETURNING` or transactional DDL.",
        "Comparing raw SQLite column types for drift."
      ],
      examples: "```ts\ndb.select({ body: notes.body }).from(notes).toSql(SQLiteDialect)\n```",
      verification: [
        "Run the identical contract suite across all dialects.",
        "Snapshot per-dialect SQL and migration DDL.",
        "Assert `dialect-isolation` (no leakage into IR/guards)."
      ],
      hardRule: "Do not write Postgres-shaped core abstractions. Dialect-specific behavior belongs in dialect adapters."
    })
  },
  {
    id: "thor.debugging",
    file: "debugging.skill.md",
    title: "Debugging",
    description: "Debug from IR to capabilities to SQL to execution.",
    content: skillMarkdown({
      title: "Debugging",
      goal: "Teach an agent to debug in pipeline order — IR → capabilities → SQL → execution → decode — instead of rewriting raw SQL.",
      useWhen: [
        "A query fails to compile, decode, guard, or migrate, or produces unexpected SQL."
      ],
      checks: [
        "Read `query.inspect()` for kind/tables/params/cardinality/capabilities.",
        "Read the tagged error: `CapabilityError`, `CompileError`, `DecodeError`, `MigrationError`.",
        "Inspect generated SQL with `.toSql(dialect)`.",
        "Check required vs supported capabilities before assuming a compiler bug.",
        "Use `thor doctor` for connectivity/journal/pending/drift/capabilities."
      ],
      safe: [
        "`query.inspect()` and `query.requiredCapabilities()` first.",
        "Compare `.toSql()` output across dialects to localize a difference."
      ],
      unsafe: [
        "Jumping straight to hand-written SQL rewrites.",
        "Suppressing a tagged error instead of reading its fields.",
        "Assuming a decode error is a driver bug (check the codec)."
      ],
      examples: "```ts\nconsole.log(query.inspect())            // shape metadata\nconsole.log(query.toSql(PostgresDialect).sql)\n```",
      verification: [
        "Reproduce with `FakeDriver` returning the offending row.",
        "Add a regression test at the failing layer.",
        "Confirm the fix keeps SQL snapshots stable."
      ],
      hardRule: "Debug from IR → capabilities → SQL → execution → decode. Do not jump straight to raw SQL rewrites."
    })
  },
  {
    id: "thor.safety",
    file: "safety.skill.md",
    title: "Safety",
    description: "Keep unsafe paths explicit, visible, and testable.",
    content: skillMarkdown({
      title: "Safety",
      goal: "Teach an agent that every unsafe path in Thor is opt-in, visible in the API, and testable — never a silent default.",
      useWhen: [
        "The user needs raw SQL, unsafe-hot mode, destructive migrations, or parameter logging."
      ],
      checks: [
        "Dynamic SQL text requires `unsafeSql(...)`; ordinary interpolation is rejected.",
        "`unsafe-hot` execution mode skips decode and is opt-in only via `withMode`.",
        "Destructive migrations require a reviewed policy; production blocks them by default.",
        "Parameter logging defaults to none/redacted; `unsafe-full` is explicit.",
        "Routine names are never interpolated."
      ],
      safe: [
        "`unsafeSql(trustedFragment)` for genuinely dynamic, non-request text.",
        "`withMode(layer, \"unsafe-hot\")` only on pre-validated compiled paths.",
        "`db.withObservability({ logParams: \"redacted\" })`."
      ],
      unsafe: [
        "Passing request data to `unsafeSql`.",
        "Defaulting to `unsafe-hot` or `unsafe-full` param logging.",
        "Auto-applying destructive migrations."
      ],
      examples: "```ts\n// Explicit, visible, testable:\nconst HotPath = withMode(PostgresLayer(client), \"unsafe-hot\")\n```",
      verification: [
        "Test that ordinary interpolation is rejected without `unsafeSql`.",
        "Assert no raw params/SQL leak by default (observability invariant).",
        "Test that destructive ops are blocked under the default policy."
      ],
      hardRule: "Unsafe paths must be explicit, visible in the API, and testable."
    })
  }
]

/** One entry in the machine-readable manifest (§21.5). */
export interface SkillManifestEntry {
  readonly id: string
  readonly file: string
  readonly description: string
}

/** The machine-readable skill index (§21.5). */
export interface SkillManifest {
  readonly name: string
  readonly version: string
  readonly project: string
  readonly scope: string
  readonly skills: ReadonlyArray<SkillManifestEntry>
}

/**
 * @returns The machine-readable manifest indexing every skill (§21.5).
 */
export const skillManifest = (): SkillManifest => ({
  name: "thor",
  version: SKILLS_VERSION,
  project: "Thor Project",
  scope: "@gilvandovieira",
  skills: SKILLS.map((skill) => ({ id: skill.id, file: skill.file, description: skill.description }))
})

/**
 * @returns The `README.md` shipped alongside the exported skills.
 */
const skillsReadme = (): string =>
  `# Thor Skills

Machine- and human-readable guidance for using Thor safely (v1 spec §21). These
skills are guidance — Thor's guards, capability checks, tests, and compilers
remain the source of truth.

## Skills

${SKILLS.map((skill) => `- \`${skill.file}\` — ${skill.description}`).join("\n")}

See \`manifest.json\` for the machine-readable index.
`

/** Export format for {@link skillFiles}. */
export type SkillExportFormat = "md" | "json"

/** A renderable output file, path relative to the export root. */
export interface SkillFile {
  /** Path under the export target, e.g. `thor/query.skill.md`. */
  readonly path: string
  /** File contents. */
  readonly content: string
}

/**
 * Render the exportable skill file set (§20.5, §21). The `thor skills export`
 * command (Epic T) writes these under its `--to` directory; this function stays
 * filesystem-free so it is testable and packageable.
 *
 * - `md`: one `.skill.md` per skill plus `README.md` and `manifest.json`.
 * - `json`: a single `thor/skills.json` bundling the manifest and full contents.
 *
 * @param format - Output format (default `md`).
 * @returns Path/content pairs to write under the target directory.
 */
export const skillFiles = (format: SkillExportFormat = "md"): ReadonlyArray<SkillFile> => {
  if (format === "json") {
    return [
      {
        path: "thor/skills.json",
        content: JSON.stringify(
          { ...skillManifest(), skills: SKILLS.map((skill) => ({ id: skill.id, file: skill.file, description: skill.description, content: skill.content })) },
          null,
          2
        ) + "\n"
      }
    ]
  }
  return [
    { path: "thor/README.md", content: skillsReadme() },
    { path: "thor/manifest.json", content: JSON.stringify(skillManifest(), null, 2) + "\n" },
    ...SKILLS.map((skill) => ({ path: `thor/${skill.file}`, content: skill.content }))
  ]
}

/**
 * The `npx skills`-installable directory name and frontmatter `name` for a
 * skill: a globally namespaced, lowercase, hyphenated slug (e.g. `thor-schema`)
 * derived from the skill id.
 *
 * @param skill - Authored skill.
 * @returns The skill's install slug.
 */
export const skillSlug = (skill: Skill): string => skill.id.replace(/\./g, "-")

/**
 * Render a skill as a `SKILL.md` document: the YAML frontmatter (`name`,
 * `description`) required by the `npx skills` installer, followed by the §21.3
 * skill body. The body is unchanged — only the discovery frontmatter is added.
 *
 * @param skill - Authored skill.
 * @returns The `SKILL.md` file contents.
 */
export const skillDocument = (skill: Skill): string =>
  `---\nname: ${skillSlug(skill)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.content}`

/**
 * Render the `npx skills`-installable file set: one `<slug>/SKILL.md` per skill,
 * with paths relative to a `skills/` discovery root. Committing these to the repo
 * (or exporting them into an agent's skills directory) lets `npx skills add`
 * discover every skill by its frontmatter (§21, spec §20.5).
 *
 * @returns Path/content pairs to write under a `skills/` root.
 */
export const installSkillFiles = (): ReadonlyArray<SkillFile> =>
  SKILLS.map((skill) => ({ path: `${skillSlug(skill)}/SKILL.md`, content: skillDocument(skill) }))
