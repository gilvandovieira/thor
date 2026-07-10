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

/** SQLite feature-matrix fixture shared by Node and Bun runtime lanes. */
export const SQLITE_FEATURE_RESET = [
  "drop table if exists users",
  "create table users (id text primary key default (lower(hex(randomblob(16)))), email text not null unique, name text, age integer, created_at text not null default current_timestamp)",
  "insert into users (id, email, name, age) values ('u1', 'seed@x.c', 'Seed', 30)",
  "drop table if exists posts",
  "create table posts (id text primary key default (lower(hex(randomblob(16)))), user_id text not null, title text not null)",
  "insert into posts (id, user_id, title) values ('p1', 'u1', 'Hello')"
] as const
