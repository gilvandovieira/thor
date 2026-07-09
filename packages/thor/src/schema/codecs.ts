/**
 * Effect Schema-backed codecs (spec §5.3).
 *
 * Codecs decode raw driver values into runtime types and validate insert/update
 * input. Decode failures surface as `DecodeError` (see ../execution).
 *
 * @module schema/codecs
 */
import { ParseResult, Schema } from "effect"

/** `timestamptz`/`timestamp` <-> `Date`. Accepts a `Date` or an ISO string from the driver. */
export const TimestampCodec: Schema.Schema<Date, Date | string> = Schema.transformOrFail(
  Schema.Union(Schema.DateFromSelf, Schema.String),
  Schema.DateFromSelf,
  {
    strict: true,
    decode: (input, _, ast) => {
      const date = input instanceof Date ? input : new Date(input)
      return Number.isNaN(date.getTime())
        ? ParseResult.fail(new ParseResult.Type(ast, input, "Invalid timestamp"))
        : ParseResult.succeed(date)
    },
    encode: (date) => ParseResult.succeed(date)
  }
)

/** Boolean codec accepting native booleans and SQLite's conventional 0/1 representation. */
export const BooleanCodec: Schema.Schema<boolean, boolean | 0 | 1> = Schema.transformOrFail(
  Schema.Union(Schema.Boolean, Schema.Literal(0, 1)),
  Schema.Boolean,
  {
    strict: true,
    decode: (input) => ParseResult.succeed(input === true || input === 1),
    encode: (value) => ParseResult.succeed(value)
  }
)

/** Scalar codec building blocks keyed by intent. */
export const codecs = {
  uuid: Schema.String,
  text: Schema.String,
  integer: Schema.Number,
  bigint: Schema.BigIntFromNumber,
  real: Schema.Number,
  boolean: BooleanCodec,
  timestamp: TimestampCodec,
  date: TimestampCodec,
  json: <A, I>(schema: Schema.Schema<A, I>) => schema,
  unknownJson: Schema.Unknown
} as const
