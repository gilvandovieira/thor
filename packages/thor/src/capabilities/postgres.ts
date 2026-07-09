/**
 * Postgres capability matrix (spec §9.4).
 *
 * @module capabilities/postgres
 */
import { defineCapabilities } from "./matrix.js"

/** Verified PostgreSQL feature support used by query guards. */
export const PostgresCapabilities = defineCapabilities("postgres", {
  "insert.returning": "native",
  "update.returning": "native",
  "delete.returning": "native",

  "insert.onConflict": "native",
  "insert.onDuplicateKey": "unsupported",

  "select.cte": "native",
  "select.recursiveCte": "native",
  "select.windowFunctions": "native",
  "select.lateralJoin": "native",
  "select.forUpdate": "native",

  "transaction.savepoints": "native",
  "transaction.isolationLevel": "native",

  "schema.json": "native",
  "schema.array": "native",
  "schema.enum": "native",
  "schema.generatedColumns": "native",
  "schema.identityColumns": "native",

  "query.streaming": "native",
  "query.preparedStatements": "native",

  "routine.functionCall": "native",
  "routine.procedureCall": "native",
  "routine.tableValuedFunction": "native",
  "routine.namedArguments": "native",
  "routine.outParameters": "native",
  "routine.overloading": "native",
  "routine.variadicArguments": "native",
  "routine.defaultArguments": "native",
  "routine.schemaQualifiedName": "native",
  "routine.extensionRequired": "native",

  "migration.lock.advisory": "native",
  "migration.lock.table": "emulated",
  "migration.transactionalDdl": "native",
  "migration.rollbackDdl": "native"
})
