/**
 * Schema DSL public surface (spec §5): column constructors, the table builder,
 * and the derived row types.
 *
 * @module schema
 */
import { Schema } from "effect"
import { makeColumn } from "./column.js"
import { codecs } from "./codecs.js"

export * from "./column.js"
export * from "./table.js"
export { BooleanCodec, codecs, TimestampCodec } from "./codecs.js"

/**
 * @param name - SQL column name.
 * @returns A nullable UUID column decoding to `string`.
 */
export const uuid = <N extends string>(name: N) => makeColumn<N, string>(name, "uuid", codecs.uuid)

/**
 * @param name - SQL column name.
 * @returns A nullable text column.
 */
export const text = <N extends string>(name: N) => makeColumn<N, string>(name, "text", codecs.text)

/**
 * @param name - SQL column name.
 * @returns A nullable variable-length text column.
 */
export const varchar = <N extends string>(name: N) => makeColumn<N, string>(name, "varchar", codecs.text)

/**
 * @param name - SQL column name.
 * @returns A nullable 4-byte integer column.
 */
export const integer = <N extends string>(name: N) => makeColumn<N, number>(name, "integer", codecs.integer)

/**
 * @param name - SQL column name.
 * @returns A nullable 8-byte integer column decoding to `bigint`.
 */
export const bigint = <N extends string>(name: N) => makeColumn<N, bigint>(name, "bigint", codecs.bigint)

/**
 * @param name - SQL column name.
 * @returns A nullable single-precision floating-point column.
 */
export const real = <N extends string>(name: N) => makeColumn<N, number>(name, "real", codecs.real)

/**
 * @param name - SQL column name.
 * @returns A nullable double-precision floating-point column.
 */
export const doublePrecision = <N extends string>(name: N) =>
  makeColumn<N, number>(name, "double precision", codecs.real)

/**
 * @param name - SQL column name.
 * @returns A nullable boolean column accepting native or `0`/`1` values.
 */
export const boolean = <N extends string>(name: N) => makeColumn<N, boolean>(name, "boolean", codecs.boolean)

/**
 * @param name - SQL column name.
 * @returns A nullable timestamp column decoding to `Date`.
 */
export const timestamp = <N extends string>(name: N) => makeColumn<N, Date>(name, "timestamptz", codecs.timestamp)

/**
 * @param name - SQL column name.
 * @returns A nullable date column decoding to `Date`.
 */
export const date = <N extends string>(name: N) => makeColumn<N, Date>(name, "date", codecs.date)

/**
 * Creates a JSON column decoded through an Effect Schema.
 *
 * @typeParam A - Decoded JSON value type.
 * @param name - SQL column name.
 * @param schema - Optional JSON value decoder; defaults to `Schema.Unknown`.
 * @returns A nullable JSON column.
 */
export const jsonb = <N extends string, A = unknown>(name: N, schema?: Schema.Schema<A, any>) =>
  makeColumn<N, A>(name, "jsonb", schema ?? codecs.unknownJson)
