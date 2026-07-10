/** Syntax-checks every README TypeScript fence and executes its core query example. */
import { readFileSync } from "node:fs"
import ts from "typescript"
import { Schema } from "effect"
import { db, eq, param, pg } from "../packages/thor/dist/index.js"
import { MySQLDialect } from "../packages/thor/dist/mysql/index.js"

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1])
if (blocks.length < 8) throw new Error(`Expected at least 8 README TypeScript examples, found ${blocks.length}`)

for (const [index, source] of blocks.entries()) {
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true
  })
  const diagnostics = result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? []
  if (diagnostics.length > 0) {
    throw new Error(`README TypeScript block ${index + 1} has syntax errors: ${diagnostics.map((item) => item.messageText).join("; ")}`)
  }
}

const posts = pg.table("posts", {
  id: pg.uuid("id").primaryKey(),
  authorId: pg.uuid("author_id").notNull(),
  title: pg.text("title").notNull()
})
const query = db
  .select({ id: posts.id, title: posts.title })
  .from(posts)
  .where(eq(posts.authorId, param("authorId", Schema.String)))
const compiled = query.toSql(MySQLDialect)
if (!compiled.sql.includes("WHERE `posts`.`author_id` = ?")) {
  throw new Error(`README query smoke test compiled unexpected SQL: ${compiled.sql}`)
}
if (compiled.paramOrder.map((parameter) => parameter.name).join() !== "authorId") {
  throw new Error("README query smoke test lost its named parameter")
}

process.stdout.write(`README examples passed (${blocks.length} syntax checks, 1 executable query).\n`)
