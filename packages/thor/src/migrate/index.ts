/**
 * Migration engine surface (spec §13). Manual, programmatic, and generated
 * migrations share this IR, DDL compiler, guards, and executor (invariant §18.4).
 */
/**
 * Migration authoring, IR, guards, compilation, journal, and live service APIs.
 *
 * @module migrate
 */
export * from "./migration-ir.js"
export * from "./define-migration.js"
export * from "./journal.js"
export * from "./ddl.js"
export * from "./expand-contract.js"
export * from "./migrator.js"
export { unsafeSql } from "../sql/raw.js"
