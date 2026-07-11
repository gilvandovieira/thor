/**
 * Effect Schema-backed codecs (spec §5.3).
 *
 * Codecs decode raw driver values into runtime types and validate insert/update
 * input. Decode failures surface as `DecodeError` (see ../execution).
 *
 * @module schema/codecs
 */
import { ParseResult, Schema } from "effect"

const DriverNumeric = Schema.Union(Schema.Number, Schema.String, Schema.BigIntFromSelf)

/** Numeric driver representations (`number`, decimal text, or bigint) decoded as a finite number. */
export const NumericCodec = Schema.transformOrFail(DriverNumeric, Schema.Number, {
  strict: true,
  decode: (input, _, ast) => {
    const value = Number(input)
    return Number.isFinite(value)
      ? ParseResult.succeed(value)
      : ParseResult.fail(new ParseResult.Type(ast, input, "Expected a finite numeric driver value"))
  },
  encode: (value) => ParseResult.succeed(value)
})

/** Integer-valued aggregate representation decoded only when it is lossless as a JS number. */
export const SafeIntegerCodec = Schema.transformOrFail(DriverNumeric, Schema.Number, {
  strict: true,
  decode: (input, _, ast) => {
    const value = Number(input)
    return Number.isSafeInteger(value)
      ? ParseResult.succeed(value)
      : ParseResult.fail(new ParseResult.Type(ast, input, "Expected a safe integer driver value"))
  },
  encode: (value) => ParseResult.succeed(value)
})

/** Lossless 64-bit integer codec accepting common driver number/string/bigint representations. */
export const BigIntCodec = Schema.transformOrFail(DriverNumeric, Schema.BigIntFromSelf, {
  strict: true,
  decode: (input, _, ast) => {
    try {
      if (typeof input === "number" && !Number.isSafeInteger(input)) {
        return ParseResult.fail(
          new ParseResult.Type(ast, input, "Unsafe number cannot be decoded losslessly as bigint")
        )
      }
      return ParseResult.succeed(BigInt(input))
    } catch {
      return ParseResult.fail(new ParseResult.Type(ast, input, "Expected an integer driver value"))
    }
  },
  encode: (value) => ParseResult.succeed(value)
})

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
  bigint: BigIntCodec,
  real: NumericCodec,
  boolean: BooleanCodec,
  timestamp: TimestampCodec,
  date: TimestampCodec,
  json: <A, I>(schema: Schema.Schema<A, I>) => schema,
  unknownJson: Schema.Unknown
} as const
