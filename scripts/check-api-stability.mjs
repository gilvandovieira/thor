/**
 * Enforces the reviewed V1 stability anchors from spec §6.
 *
 * This is intentionally narrower than the JSDoc audit: implementation helpers
 * need documentation, but only package-facing contracts need release stability
 * tags. The anchor list prevents the settled API families from silently losing
 * or changing classification as source files are split.
 */
import fs from "node:fs"
import ts from "typescript"

const Stable = "stable"
const Experimental = "experimental"
const Internal = "internal"

const anchors = [
  ["packages/thor/src/schema/column.ts", "Column", Stable],
  ["packages/thor/src/schema/table.ts", "defineTable", Stable],
  ["packages/thor/src/schema/table.ts", "Select", Stable],
  ["packages/thor/src/postgres/index.ts", "pg", Stable],
  ["packages/thor/src/sqlite/index.ts", "sqlite", Stable],
  ["packages/thor/src/mysql/index.ts", "mysql", Stable],
  ["packages/thor/src/sql/query-builder.ts", "db", Stable],
  ["packages/thor/src/sql/query-builder.ts", "SelectQuery", Stable],
  ["packages/thor/src/sql/mutation-builder.ts", "ReturningQuery", Stable],
  ["packages/thor/src/sql/query-builder.ts", "QueryReference", Stable],
  ["packages/thor/src/sql/query-builder-support.ts", "PreparedQuery", Experimental],
  ["packages/thor/src/execution/compiled-query.ts", "CompiledQuery", Stable],
  ["packages/thor/src/execution/compiled-query.ts", "CompileOptions", Stable],
  ["packages/thor/src/execution/plan.ts", "withMode", Experimental],
  ["packages/thor/src/execution/plan.ts", "withQueryCache", Stable],
  ["packages/thor/src/migrate/define-migration.ts", "MigrationDefinition", Stable],
  ["packages/thor/src/migrate/define-migration.ts", "defineMigration", Stable],
  ["packages/thor/src/migrate/migrator.ts", "MigratorService", Stable],
  ["packages/thor/src/migrate/migrator.ts", "Migrator", Stable],
  ["packages/thor/src/migrate/migration-ir.ts", "MigrationPlan", Stable],
  ["packages/thor/src/errors/index.ts", "ThorError", Stable],
  ["packages/thor/src/capabilities/capability.ts", "ALL_CAPABILITIES", Stable],
  ["packages/thor/src/capabilities/capability.ts", "Capability", Stable],
  ["packages/thor/src/capabilities/runtime.ts", "RuntimeCapabilityProfile", Experimental],
  ["packages/thor/src/capabilities/runtime.ts", "detectRuntimeCapabilities", Experimental],
  ["packages/thor/src/dialect.ts", "Dialect", Stable],
  ["packages/thor/src/execution/driver.ts", "Driver", Stable],
  ["packages/thor/src/testing/fake-driver.ts", "FakeDriver", Stable],
  ["packages/thor/src/testing/fake-database-layer.ts", "FakeDatabaseLayer", Stable],
  ["packages/thor/src/testing/expect-sql.ts", "expectSql", Stable],
  ["packages/thor/src/testing/contract-suite.ts", "makeDialectContractSuite", Experimental],
  ["packages/thor/src/observability/index.ts", "ObservabilityOptions", Stable],
  ["packages/thor/src/observability/index.ts", "withObservability", Stable],
  ["packages/thor/src/execution/cache.ts", "QueryCaches", Internal],
  ["packages/thor/src/ir/query-ir.ts", "QueryIR", Internal],
  ["packages/cli/src/commands.ts", "init", Stable],
  ["packages/cli/src/commands.ts", "create", Stable],
  ["packages/cli/src/commands.ts", "capabilities", Stable]
]

const errors = []
const parsed = new Map()

const sourceFor = (file) => {
  let source = parsed.get(file)
  if (!source) {
    source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    parsed.set(file, source)
  }
  return source
}

const declarationName = (node) => {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text
  if (ts.isVariableStatement(node)) {
    const declaration = node.declarationList.declarations[0]
    return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined
  }
  return undefined
}

const stabilityTags = (node) =>
  ts
    .getJSDocTags(node)
    .map((tag) => tag.tagName.text)
    .filter((name) => name === Stable || name === Experimental || name === Internal)

const findDeclaration = (source, name) => source.statements.find((statement) => declarationName(statement) === name)

for (const [file, name, expected] of anchors) {
  const source = sourceFor(file)
  const declaration = findDeclaration(source, name)
  if (!declaration) {
    errors.push(`${file}: missing stability anchor declaration ${name}`)
    continue
  }
  const tags = stabilityTags(declaration)
  if (tags.length !== 1 || tags[0] !== expected) {
    errors.push(
      `${file}: ${name} must have exactly @${expected}; found ${tags.map((tag) => `@${tag}`).join(", ") || "none"}`
    )
  }
}

// The builder classes are split across three files; the terminal-method
// stability contract is audited in each so a move never drops coverage.
const builderFiles = [
  "packages/thor/src/sql/query-builder.ts",
  "packages/thor/src/sql/mutation-builder.ts",
  "packages/thor/src/sql/query-builder-support.ts"
]
for (const file of builderFiles) {
  for (const statement of sourceFor(file).statements) {
    if (!ts.isClassDeclaration(statement)) continue
    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) || !member.name || !ts.isIdentifier(member.name)) continue
      const name = member.name.text
      const expected = ["all", "one", "maybeOne", "run"].includes(name)
        ? Stable
        : name === "inspect" || name === "prepare"
          ? Experimental
          : undefined
      if (!expected) continue
      const tags = stabilityTags(member)
      if (tags.length !== 1 || tags[0] !== expected) {
        errors.push(`${file}: ${statement.name?.text ?? "anonymous"}.${name} must have exactly @${expected}`)
      }
    }
  }
}

const compiledQuery = sourceFor("packages/thor/src/execution/compiled-query.ts")
for (const statement of compiledQuery.statements) {
  if (!ts.isClassDeclaration(statement) && !ts.isInterfaceDeclaration(statement)) continue
  for (const member of statement.members) {
    if (
      (!ts.isMethodDeclaration(member) && !ts.isMethodSignature(member)) ||
      !member.name ||
      !ts.isIdentifier(member.name)
    )
      continue
    const name = member.name.text
    const expected = ["execute", "compile", "compilePrepared"].includes(name)
      ? Stable
      : name === "compileUnsafeHot"
        ? Experimental
        : undefined
    if (!expected) continue
    const tags = stabilityTags(member)
    if (tags.length !== 1 || tags[0] !== expected) {
      errors.push(
        `packages/thor/src/execution/compiled-query.ts: ${statement.name?.text ?? "anonymous"}.${name} must have exactly @${expected}`
      )
    }
  }
}

const errorSource = sourceFor("packages/thor/src/errors/index.ts")
for (const statement of errorSource.statements) {
  if (!ts.isClassDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) continue
  if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
  const tags = stabilityTags(statement)
  if (tags.length !== 1 || tags[0] !== Stable) {
    errors.push(`packages/thor/src/errors/index.ts: ${statement.name.text} must have exactly @stable`)
  }
}

const rootSource = fs.readFileSync("packages/thor/src/index.ts", "utf8")
for (const name of [
  "QueryCaches",
  "WeakCacheLayer",
  "BoundedLruCache",
  "makeQueryCaches",
  "defaultQueryCaches",
  "normalizeQuery",
  "queryStructuralHash",
  "collectQueryParams",
  "queryCapabilityBits",
  "QueryIR"
]) {
  if (new RegExp(`\\b${name}\\b`).test(rootSource)) {
    errors.push(`packages/thor/src/index.ts: internal symbol ${name} must not be re-exported from the root`)
  }
}

const v1Spec = fs.readFileSync("docs/thor-project-v1-spec.md", "utf8")
if (v1Spec.includes("execution methods: all, one, maybeOne, run, stream")) {
  errors.push(
    "docs/thor-project-v1-spec.md: stream must not be listed as a stable terminal while no scoped cursor API exists"
  )
}

if (errors.length > 0) {
  console.error(`API stability audit failed with ${errors.length} issue(s):`)
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(`API stability audit passed for ${anchors.length} public contract anchors.`)
}
