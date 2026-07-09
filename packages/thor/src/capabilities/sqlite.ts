/**
 * SQLite capability matrix used by query and migration guards.
 *
 * @module capabilities/sqlite
 */
import { defineCapabilities } from "./matrix.js"

/** Verified SQLite feature support and explicit emulation boundaries. */
export const SQLiteCapabilities = defineCapabilities("sqlite", {
  "insert.returning": "native",
  "update.returning": "native",
  "delete.returning": "native",
  "insert.onConflict": "native",
  "insert.onDuplicateKey": "unsupported",
  "select.cte": "native",
  "select.recursiveCte": "native",
  "select.windowFunctions": "native",
  "select.lateralJoin": "unsupported",
  "select.rightJoin": "native",
  "select.fullJoin": "native",
  "select.setOperations": "native",
  "select.forUpdate": "unsupported",
  "transaction.savepoints": "native",
  "transaction.isolationLevel": "emulated",
  "schema.json": "emulated",
  "schema.array": "unsupported",
  "schema.enum": "emulated",
  "schema.generatedColumns": "native",
  "schema.identityColumns": "emulated",
  "query.streaming": "unknown",
  "query.preparedStatements": "native",
  "routine.functionCall": "unsupported",
  "routine.procedureCall": "unsupported",
  "routine.tableValuedFunction": "unsupported",
  "routine.namedArguments": "unsupported",
  "routine.outParameters": "unsupported",
  "routine.overloading": "unsupported",
  "routine.variadicArguments": "unsupported",
  "routine.defaultArguments": "unsupported",
  "routine.schemaQualifiedName": "unsupported",
  "routine.extensionRequired": "unsupported",
  "migration.lock.advisory": "unsupported",
  "migration.lock.table": "emulated",
  "migration.transactionalDdl": "native",
  "migration.rollbackDdl": "native"
})
