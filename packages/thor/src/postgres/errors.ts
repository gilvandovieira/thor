/**
 * Native Postgres error → tagged Thor error mapping, shared by every Postgres
 * client adapter (node-postgres, postgres.js, ...). Both clients surface the
 * SQLSTATE `code`, so constraint classification is client-independent.
 *
 * @module postgres/errors
 */
import { ConstraintError, DriverError } from "../errors/index.js"

/** SQLSTATE classes we normalize into `ConstraintError`. */
const CONSTRAINT_CODES: Record<string, ConstraintError["kind"]> = {
  "23505": "unique",
  "23503": "foreignKey",
  "23514": "check",
  "23502": "notNull"
}

/**
 * @param cause - Native PostgreSQL client failure.
 * @returns A normalized constraint or driver error.

 */
export const mapDriverError = (cause: unknown): DriverError | ConstraintError => {
  const err = cause as { code?: string; constraint?: string; constraint_name?: string; message?: string } | undefined
  const kind = err?.code ? CONSTRAINT_CODES[err.code] : undefined
  if (kind) {
    // node-postgres exposes `.constraint`; postgres.js exposes `.constraint_name`.
    const constraint = err?.constraint ?? err?.constraint_name ?? "unknown"
    return new ConstraintError({ kind, constraint, message: `Constraint violation (${err!.code})`, cause })
  }
  return new DriverError({ message: err?.message ?? "Driver error", cause })
}
