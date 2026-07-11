/**
 * Enforces the reviewed public API from the manifest at docs/api-manifest.json
 * (spec §6). The manifest is the single source of truth for every compatibility
 * commitment; this checker verifies the implementation still matches it:
 *
 *   - each anchor declaration carries exactly its recorded stability tag;
 *   - the package export map equals the manifest's reviewed subpath set;
 *   - stable terminal methods, compiled-query methods, and error tags keep
 *     their classification;
 *   - the tagged-error set and capability-name set match the recorded snapshot
 *     (so a removed or accidentally-added export/tag/capability fails loudly);
 *   - internal IR/cache symbols never leak through the stable root;
 *   - the v1 spec never re-lists a deferred terminal (stream) as stable.
 */
import fs from "node:fs"
import ts from "typescript"

const Stable = "stable"
const Experimental = "experimental"
const Internal = "internal"

const manifest = JSON.parse(fs.readFileSync("docs/api-manifest.json", "utf8"))
const anchors = manifest.anchors.map((entry) => [entry.file, entry.symbol, entry.stability])

const errors = []
const parsed = new Map()

/**
 * @param actual - Set found in the implementation.
 * @param expected - Reviewed set from the manifest.
 * @param label - Human-readable name of the set for diagnostics.
 * @returns Nothing; records added/removed differences as errors.
 */
const diffSet = (actual, expected, label) => {
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  for (const name of actualSet) {
    if (!expectedSet.has(name)) {
      errors.push(
        `${label}: "${name}" is present in the implementation but not the reviewed manifest (added without review?)`
      )
    }
  }
  for (const name of expectedSet) {
    if (!actualSet.has(name)) {
      errors.push(
        `${label}: manifest lists "${name}" but it is missing from the implementation (removed without review?)`
      )
    }
  }
}

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
for (const name of manifest.rootSealedSymbols) {
  if (new RegExp(`\\b${name}\\b`).test(rootSource)) {
    errors.push(`packages/thor/src/index.ts: internal symbol ${name} must not be re-exported from the root`)
  }
}

// The published subpath export map must equal the reviewed set exactly — a new
// public entry point or a removed one is a compatibility event.
const thorManifest = JSON.parse(fs.readFileSync("packages/thor/package.json", "utf8"))
diffSet(Object.keys(thorManifest.exports ?? {}), manifest.exports, "package export map")

// The tagged-error set is a stable contract (docs/errors.md). Snapshot it from
// the Data.TaggedError declarations and diff against the manifest.
const errorTags = [
  ...fs.readFileSync("packages/thor/src/errors/index.ts", "utf8").matchAll(/Data\.TaggedError\("([A-Za-z]+)"\)/g)
].map((match) => match[1])
diffSet(errorTags, manifest.errorTags, "tagged-error set")

// The capability-name set feeds guards, cache keys, and the CLI; a rename is a
// contract change. Snapshot the `ALL_CAPABILITIES` string-literal array.
const capabilitySource = fs.readFileSync("packages/thor/src/capabilities/capability.ts", "utf8")
const capabilityBlock = capabilitySource.slice(
  capabilitySource.indexOf("ALL_CAPABILITIES"),
  capabilitySource.indexOf("] as const")
)
const capabilityNames = [...capabilityBlock.matchAll(/"([a-z]+\.[a-zA-Z]+)"/g)].map((match) => match[1])
diffSet(capabilityNames, manifest.capabilities, "capability-name set")

// Stable CLI commands must all exist as exported command functions.
const cliSource = fs.readFileSync("packages/cli/src/commands.ts", "utf8")
for (const command of manifest.cliCommands) {
  if (!new RegExp(`export const ${command}\\b`).test(cliSource)) {
    errors.push(`packages/cli/src/commands.ts: stable CLI command "${command}" is missing its exported implementation`)
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
  console.log(
    `API stability audit passed: ${anchors.length} anchors, ${manifest.exports.length} exports, ${manifest.errorTags.length} error tags, ${manifest.capabilities.length} capabilities.`
  )
}
