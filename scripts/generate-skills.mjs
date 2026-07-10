/**
 * Generates the `npx skills`-installable skill files under the repo-root
 * `skills/` directory: one `<slug>/SKILL.md` per authored skill, each carrying
 * the YAML frontmatter (`name`, `description`) the installer requires. This is
 * what makes `npx skills add gilvandovieira/thor` discover Thor's skills.
 *
 * Run with `--check` to fail (CI/`docs:check`) when the committed files drift
 * from the authored skills; run with no arguments to (re)write them.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { installSkillFiles } from "../packages/thor/dist/skills/index.js"

const root = "skills"
const check = process.argv.includes("--check")
const files = installSkillFiles()
const expected = new Map(files.map((file) => [join(root, file.path), file.content]))

// Existing on-disk SKILL.md files, so removed skills are detected as drift.
const onDisk = existsSync(root)
  ? readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, "SKILL.md"))
      .filter((path) => existsSync(path))
  : []

if (check) {
  const drift = []
  for (const [path, content] of expected) {
    const current = existsSync(path) ? readFileSync(path, "utf8") : null
    if (current !== content) drift.push(current === null ? `${path} (missing)` : `${path} (stale)`)
  }
  for (const path of onDisk) if (!expected.has(path)) drift.push(`${path} (orphan)`)

  if (drift.length > 0) {
    console.error(`Installable skills are out of date:\n${drift.map((line) => `- ${line}`).join("\n")}`)
    console.error("Run: node scripts/generate-skills.mjs")
    process.exitCode = 1
  } else {
    console.log(`Installable skills are current (${files.length} SKILL.md files under ${root}/).`)
  }
} else {
  for (const path of onDisk) if (!expected.has(path)) rmSync(dirname(path), { recursive: true, force: true })
  for (const [path, content] of expected) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  console.log(`Wrote ${files.length} SKILL.md files under ${root}/.`)
}
