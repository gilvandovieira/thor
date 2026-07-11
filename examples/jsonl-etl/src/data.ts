import { Data, Effect, Schema } from "effect"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { EventPayload, EventTags, type NewRawEvent } from "./schema.js"

const InputEvent = Schema.Struct({
  eventId: Schema.String,
  source: Schema.Literal("store-na", "store-eu", "store-br"),
  eventType: Schema.Literal("view", "cart", "purchase", "refund"),
  occurredAt: Schema.String,
  amount: Schema.Number,
  currency: Schema.Literal("USD", "EUR", "BRL"),
  country: Schema.String,
  tags: EventTags,
  payload: EventPayload
})

type InputEvent = Schema.Schema.Type<typeof InputEvent>

export class InputFileError extends Data.TaggedError("InputFileError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class InputRowError extends Data.TaggedError("InputRowError")<{
  readonly line: number
  readonly message: string
  readonly cause?: unknown
}> {}

const SOURCE_IDS = ["store-na", "store-eu", "store-br"] as const
const EVENT_TYPES = ["view", "cart", "purchase", "refund"] as const
const COUNTRIES = ["US", "CA", "DE", "FR", "BR", "AR"] as const
const CHANNELS = ["web", "mobile", "partner"] as const
const TIERS = ["free", "pro", "enterprise"] as const
const FX = { USD: 1, EUR: 1.08, BRL: 0.18 } as const

const cycle = <A>(values: readonly [A, ...A[]], index: number): A => values[index % values.length] ?? values[0]

const generatedEvent = (index: number): InputEvent => {
  const source = cycle(SOURCE_IDS, index)
  const eventType = cycle(EVENT_TYPES, index * 7)
  const currency = source === "store-eu" ? "EUR" : source === "store-br" ? "BRL" : "USD"
  const occurredAt = new Date(Date.UTC(2026, 0, 1 + (index % 28), index % 24, (index * 13) % 60))
  return {
    // The final 3,000 lines intentionally update earlier events through ON CONFLICT.
    eventId: `evt-${String(index % 12_000).padStart(6, "0")}`,
    source,
    eventType,
    occurredAt: occurredAt.toISOString(),
    amount: eventType === "view" ? 0 : Number((((index * 37) % 45_000) / 100 + 1).toFixed(2)),
    currency,
    country: cycle(COUNTRIES, index),
    tags: [eventType, index % 11 === 0 ? "promotion" : "organic"],
    payload: {
      channel: cycle(CHANNELS, index),
      campaign: `campaign-${index % 9}`,
      customerTier: cycle(TIERS, index)
    }
  }
}

export const ensureInputFile = (path: string, rows = 15_000) =>
  Effect.gen(function* () {
    const exists = yield* Effect.tryPromise({
      try: async () => {
        try {
          await stat(path)
          return true
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false
          throw cause
        }
      },
      catch: (cause) => new InputFileError({ message: `Cannot inspect ${path}`, cause })
    })
    if (exists) return

    const body = `${Array.from({ length: rows }, (_, index) => JSON.stringify(generatedEvent(index))).join("\n")}\n`
    const temporaryPath = `${path}.${process.pid}.tmp`
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true })
        try {
          await writeFile(temporaryPath, body, "utf8")
          await rename(temporaryPath, path)
        } finally {
          await rm(temporaryPath, { force: true })
        }
      },
      catch: (cause) => new InputFileError({ message: `Cannot generate ${path}`, cause })
    })
  })

const normalize = (event: InputEvent): NewRawEvent => {
  const occurredAt = new Date(event.occurredAt)
  if (Number.isNaN(occurredAt.getTime())) throw new TypeError("occurredAt must be an ISO timestamp")
  if (event.eventId.trim().length === 0) throw new TypeError("eventId must not be empty")
  if (event.country.trim().length === 0) throw new TypeError("country must not be empty")
  if (event.amount < 0) throw new TypeError("amount must not be negative")
  return {
    eventId: event.eventId.trim(),
    sourceId: event.source,
    eventType: event.eventType,
    occurredAt,
    occurredDay: occurredAt.toISOString().slice(0, 10),
    amountUsd: Number((event.amount * FX[event.currency]).toFixed(2)),
    country: event.country.trim().toUpperCase(),
    tags: [...new Set(event.tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0))],
    payload: event.payload
  }
}

export const readInput = (path: string, onRow?: (line: number) => void) =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => new InputFileError({ message: `Cannot read ${path}`, cause })
    })
    const lines = text
      .split("\n")
      .map((line, index) => ({ line, lineNumber: index + 1 }))
      .filter(({ line }) => line.length > 0)
    return yield* Effect.forEach(
      lines,
      ({ line, lineNumber }) => {
        onRow?.(lineNumber)
        return Effect.try({
          try: () => JSON.parse(line) as unknown,
          catch: (cause) => new InputRowError({ line: lineNumber, message: "Invalid JSON", cause })
        }).pipe(
          Effect.flatMap(Schema.decodeUnknown(InputEvent)),
          Effect.flatMap((event) =>
            Effect.try({
              try: () => normalize(event),
              catch: (cause) =>
                new InputRowError({ line: lineNumber, message: "Input has invalid domain values", cause })
            })
          ),
          Effect.mapError((cause) =>
            cause instanceof InputRowError
              ? cause
              : new InputRowError({ line: lineNumber, message: "Input does not match the event schema", cause })
          )
        )
      },
      { concurrency: 32 }
    )
  })
