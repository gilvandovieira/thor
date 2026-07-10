/**
 * MySQL 8 capability matrix used by query and migration guards.
 *
 * @module capabilities/mysql
 */
import { defineVerifiedCapabilities } from "./matrix.js"

/** Verified MySQL 8 feature support and unsupported PostgreSQL-style features. */
export const MySQLCapabilities = defineVerifiedCapabilities("mysql", {
  "insert.returning": "unsupported",
  "update.returning": "unsupported",
  "delete.returning": "unsupported",
  "insert.onConflict": "unsupported",
  "insert.onDuplicateKey": "native",
  "select.cte": "native",
  "select.recursiveCte": "native",
  "select.windowFunctions": "native",
  "select.lateralJoin": "native",
  "select.rightJoin": "native",
  "select.fullJoin": "unsupported",
  "select.setOperations": "native",
  "select.forUpdate": "unknown",
  "transaction.savepoints": "native",
  "transaction.isolationLevel": "native",
  "schema.json": "native",
  "schema.array": "unsupported",
  "schema.enum": "unknown",
  "schema.generatedColumns": "native",
  "schema.identityColumns": "emulated",
  "query.streaming": "unknown",
  "query.preparedStatements": "native",
  "routine.functionCall": "native",
  "routine.procedureCall": "native",
  "routine.tableValuedFunction": "unsupported",
  "routine.namedArguments": "unsupported",
  "routine.outParameters": "unknown",
  "routine.overloading": "unsupported",
  "routine.variadicArguments": "unsupported",
  "routine.defaultArguments": "unsupported",
  "routine.schemaQualifiedName": "native",
  "routine.extensionRequired": "unsupported",
  "migration.lock.advisory": "native",
  "migration.lock.table": "native",
  "migration.transactionalDdl": "unsupported",
  "migration.rollbackDdl": "unsupported"
})
