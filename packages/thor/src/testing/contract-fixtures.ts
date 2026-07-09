/**
 * Shared database fixtures for dialect contract harnesses.
 *
 * Keeping reset SQL beside the runner-agnostic suite ensures Node and Bun
 * execute the same SQLite schema instead of maintaining runtime-specific copies.
 *
 * @module testing/contract-fixtures
 */

/** SQLite fixture reset executed before every shared contract case. */
export const SQLITE_CONTRACT_RESET = [
  "drop table if exists contract_users",
  "create table contract_users (id integer primary key, email text not null unique, name text, age integer)"
] as const
