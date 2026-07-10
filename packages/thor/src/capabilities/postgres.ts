/**
 * Postgres capability matrix (spec §9.4).
 *
 * @module capabilities/postgres
 */
import { defineVerifiedCapabilities } from "./matrix.js"

/** Verified PostgreSQL feature support used by query guards. */
export const PostgresCapabilities = defineVerifiedCapabilities("postgres", {
  "insert.returning": "native",
  "update.returning": "native",
  "delete.returning": "native",

  "insert.onConflict": "native",
  "insert.onDuplicateKey": "unsupported",

  "select.cte": "native",
  "select.recursiveCte": "native",
  "select.windowFunctions": "native",
  "select.lateralJoin": "native",
  "select.rightJoin": "native",
  "select.fullJoin": "native",
  "select.setOperations": "native",
  "select.forUpdate": "unknown",

  "transaction.savepoints": "native",
  "transaction.isolationLevel": "native",

  "schema.json": "native",
  "schema.array": "unknown",
  "schema.enum": "unknown",
  "schema.generatedColumns": "native",
  "schema.identityColumns": "unknown",

  "query.streaming": "unknown",
  "query.preparedStatements": "native",

  "routine.functionCall": "native",
  "routine.procedureCall": "native",
  "routine.tableValuedFunction": "native",
  "routine.namedArguments": "unknown",
  "routine.outParameters": "unknown",
  "routine.overloading": "unknown",
  "routine.variadicArguments": "unknown",
  "routine.defaultArguments": "unknown",
  "routine.schemaQualifiedName": "native",
  "routine.extensionRequired": "unknown",

  "migration.lock.advisory": "native",
  "migration.lock.table": "emulated",
  "migration.transactionalDdl": "native",
  "migration.rollbackDdl": "native"
})
