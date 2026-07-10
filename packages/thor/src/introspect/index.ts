/**
 * Live-database introspection (spec §16). Reads a database's shape into a
 * dialect-neutral Schema IR, the basis for drift detection.
 *
 * @module introspect
 */
export * from "./schema-ir.js"
export * from "./drift.js"
export * from "./introspector.js"
export { PostgresIntrospection } from "./postgres.js"
export { SQLiteIntrospection } from "./sqlite.js"
export { MySQLIntrospection } from "./mysql.js"
