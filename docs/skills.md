# LLM skills

Thor ships 11 human- and machine-readable skills that teach coding agents how
to use its declared APIs safely. They are available programmatically from
`@gilvandovieira/thor/skills` and can be listed or exported with the `thor`
CLI.

Skills are guidance, not an alternate execution or policy layer. Thor's query
guards, capability checks, compilers, codecs, migration policies, and tests
remain the source of truth at runtime.

## Install with `npx skills`

The repository ships the skills in the [`npx skills`](https://github.com/vercel-labs/skills)
convention — a top-level [`skills/`](../skills) directory with one
`<name>/SKILL.md` per skill, each carrying the `name`/`description` frontmatter
the installer requires. Install all of them into your agent (Claude Code, Cursor,
Codex, …) with:

```sh
npx skills add gilvandovieira/thor
```

Install only the ones you need with `--skill` (names are `thor-<id>`):

```sh
npx skills add gilvandovieira/thor --skill thor-schema --skill thor-query
```

The `skills/` directory is generated from the authored `SKILLS` catalog by
`node scripts/generate-skills.mjs`; `pnpm docs:check` fails if it drifts, so the
installable files never fall out of sync with the source of truth. (`npx skills`
installs from the Git repository; to render the same files into your own project
instead, use `thor skills export` below.)

## Included skills

`SKILLS` is the ordered, read-only catalog. Each entry has a dotted `id`, export
file name, title, one-line description, and complete Markdown `content`.

| ID | Export file | Focus |
|---|---|---|
| `thor.schema` | `schema.skill.md` | Tables, columns, keys, constraints, inferred row types, and dialect-aware schema design |
| `thor.query` | `query.skill.md` | Fluent queries, parameters, cardinality, compilation, and SQL-injection boundaries |
| `thor.effect-execution` | `effect-execution.skill.md` | Effect terminals, database layers, transactions, resources, retries, and typed errors |
| `thor.migrations` | `migrations.skill.md` | Planning, dry runs, drift, policies, destructive changes, and expand/contract staging |
| `thor.capabilities` | `capabilities.skill.md` | Dialect and runtime capability checks and conservative failure |
| `thor.routines` | `routines.skill.md` | Functions, aggregates, table functions, procedures, volatility, and transaction requirements |
| `thor.testing` | `testing.skill.md` | Type, SQL snapshot, fake-driver, contract, property, and integration tests |
| `thor.benchmarks` | `benchmarks.skill.md` | Cold, warm, prepared, cache, Node, Bun, and regression-gate measurements |
| `thor.dialects` | `dialects.skill.md` | Keeping PostgreSQL, SQLite, and MySQL behavior in dialect adapters |
| `thor.debugging` | `debugging.skill.md` | Debugging in IR, capability, SQL, execution, and decode order |
| `thor.safety` | `safety.skill.md` | Explicit raw SQL, unsafe-hot execution, destructive migration, and logging boundaries |

Every skill follows the same document shape: Goal, Use When, Required Checks,
Safe Patterns, Unsafe Patterns, Examples, Verification, and Hard Rule. The hard
rules make high-risk boundaries prominent, but an agent following a skill does
not prove that generated code is valid or safe.

## Programmatic API

Import the catalog and renderers through the package's `./skills` subpath:

```ts
import {
  SKILLS,
  skillFiles,
  skillManifest
} from "@gilvandovieira/thor/skills"

const querySkill = SKILLS.find((skill) => skill.id === "thor.query")
const manifest = skillManifest()
const markdownFiles = skillFiles()       // same as skillFiles("md")
const jsonFiles = skillFiles("json")
```

`skillManifest()` returns a new machine-readable index with this shape:

```ts
{
  name: "thor",
  version: "1.0.0-draft",
  project: "Thor Project",
  scope: "@gilvandovieira",
  skills: [
    {
      id: "thor.schema",
      file: "schema.skill.md",
      description: "Define Thor schemas safely."
    }
    // ...10 more entries
  ]
}
```

The manifest deliberately omits full skill content. Its `version` is
`SKILLS_VERSION` and versions the skill content, independently of the npm
package version.

`skillFiles(format)` returns read-only `{ path, content }` pairs. It does not
create directories or write files:

- `skillFiles()` and `skillFiles("md")` return 13 files under `thor/`: one
  `.skill.md` file per skill, `README.md`, and `manifest.json`.
- `skillFiles("json")` returns one file, `thor/skills.json`. The JSON repeats
  each manifest entry and adds its full Markdown `content`.
- Every returned path is relative to an export root and is owned by Thor; callers
  decide whether, where, and how to persist it.

For example, a non-CLI host can keep filesystem policy outside the Thor package:

```ts
for (const file of skillFiles("md")) {
  // Validate the destination according to the host's policy, then write
  // file.path and file.content with the host's filesystem abstraction.
}
```

## CLI

List the catalog without writing files:

```sh
thor skills list
```

The output is a tab-separated `Skill`/`Description` table with one row per
entry in `SKILLS`.

Export the skills with:

```sh
thor skills export
thor skills export --format md
thor skills export --format json
thor skills export --to .agents/skills
```

CLI defaults and options:

| Option | Default | Behavior |
|---|---|---|
| `--format` | `md` | Accepts exactly `md` or `json`; other values fail with usage output and a non-zero exit |
| `--to` | `.agents/skills` | Selects the export root; relative paths resolve from the current working directory and absolute paths are honored |

The renderer always includes its own `thor/` path segment. Consequently, the
default Markdown export is:

```txt
.agents/skills/
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
    benchmarks.skill.md
    dialects.skill.md
    debugging.skill.md
    safety.skill.md
```

The default JSON destination is `.agents/skills/thor/skills.json`. Pass the
parent export root to `--to`; passing a path already ending in `thor` produces
an additional `thor/` directory. The CLI creates missing parent directories,
writes synchronously, overwrites files with matching names, and reports the
number of files and the displayed destination when complete.

## Filesystem boundary

The API and CLI intentionally have different responsibilities:

- `SKILLS`, `skillManifest()`, and `skillFiles()` are deterministic,
  filesystem-free package APIs. They perform no database, driver, network, or
  Effect work.
- `thor skills list` only writes its table to standard output.
- `thor skills export` is the filesystem host. It resolves `--to`, recursively
  creates directories, and writes every rendered path.

This keeps rendering portable and easy to test while making filesystem effects
visible at the CLI boundary. Because `--to` may be absolute and existing files
are overwritten, review the destination before running exports in automation or
against a shared directory. Thor controls the relative artifact names, but the
operator controls the export root.

## Guidance and enforcement

The skills prefer declared schema/query/routine APIs, require capability checks,
and prohibit interpolating user input into raw SQL. They also call out explicit
opt-ins such as `unsafeSql`, `unsafe-hot`, full parameter logging, and reviewed
destructive migrations.

Those instructions improve agent behavior, but runtime enforcement still comes
from Thor itself. In particular:

- capability guards reject unsupported or unknown features before driver I/O;
- codecs and cardinality terminals validate inputs and results;
- migration policy gates destructive operations;
- execution modes and unsafe SQL remain explicit API choices;
- tests and dialect compilers define actual behavior when prose and code differ.

Do not use skill text as an authorization control, input validator, capability
probe, or substitute for reviewing generated migrations and SQL.

## Performance and stability

Importing `SKILLS` loads the authored Markdown strings into memory. Manifest and
file rendering are linear in the 11-entry catalog and perform no I/O; JSON export
also serializes all Markdown into one bundle. This work is intended for tooling
and export paths, not request-time database hot paths. The CLI uses synchronous
filesystem writes, which favors simple, deterministic command completion over
server-style concurrency.

The LLM skills export surface is classified `@experimental`: its data shapes,
content, file layout, and draft skill-content version may change while the
feature settles. The CLI `skills` command handler itself is tagged `@stable`, so
the command is supported, while consumers should still treat exported skill
artifacts as generated files and regenerate rather than hand-maintain them. See
[API stability](api-stability.md) for Thor's stability levels.

## Tests

`packages/thor/test/skills.test.ts` verifies:

- the exact 11 skill IDs, their order, and ID-derived file names;
- every required Markdown section and hard rule;
- manifest metadata and complete indexing;
- the 13-file Markdown set and valid manifest JSON;
- the single-file JSON bundle and embedded content;
- the capability-checking, `unsafeSql`, and no-raw-interpolation invariants.

`packages/cli/test/cli.test.ts` exercises the built CLI in subprocesses. It
checks list headers and row count, Markdown and JSON files on disk, the default
JSON destination, and non-zero failures for unsupported formats and unknown
subcommands.

Build first because tests resolve workspace package exports from `dist`:

```sh
pnpm build
pnpm exec vitest run packages/thor/test/skills.test.ts
pnpm exec vitest run packages/cli/test/cli.test.ts
```
