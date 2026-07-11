/**
 * Internal runtime identity for explicitly unsafe SQL nodes.
 *
 * @module ir/unsafe-sql
 */
import type { UnsafeSqlNode } from "./query-ir.js"
import { authenticitySet } from "./authenticity.js"

const unsafeSqlNodes = authenticitySet("unsafe-sql")

/** @param sql - Trusted SQL text. @returns A runtime-branded unsafe SQL node. */
export const createUnsafeSqlNode = (sql: string): UnsafeSqlNode => {
  if (typeof sql !== "string") throw new TypeError("unsafeSql(...) requires a string")
  const node: UnsafeSqlNode = { _tag: "UnsafeSql", sql }
  unsafeSqlNodes.add(node)
  return node
}

/** @param value - Candidate node. @returns Whether it was created by `unsafeSql(...)`. */
export const isUnsafeSqlNode = (value: unknown): value is UnsafeSqlNode =>
  typeof value === "object" && value !== null && unsafeSqlNodes.has(value)
