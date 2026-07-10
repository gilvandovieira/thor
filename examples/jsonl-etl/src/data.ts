import { Data, Effect, Schema } from "effect"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
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

const generatedEvent = (index: number): InputEvent => {
  const source = SOURCE_IDS[index % SOURCE_IDS.length]!
  const eventType = EVENT_TYPES[(index * 7) % EVENT_TYPES.length]!
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
    country: COUNTRIES[index % COUNTRIES.length]!,
    tags: [eventType, index % 11 === 0 ? "promotion" : "organic"],
    payload: {
      channel: CHANNELS[index % CHANNELS.length]!,
      campaign: `campaign-${index % 9}`,
      customerTier: TIERS[index % TIERS.length]!
    }
  }
}

export const ensureInputFile = (path: string, rows = 15_000) => Effect.gen(function* () {
  const exists = yield* Effect.tryPromise({
    try: () => stat(path).then(() => true, () => false),
    catch: (cause) => new InputFileError({ message: `Cannot inspect ${path}`, cause })
  })
  if (exists) return

  const body = Array.from({ length: rows }, (_, index) => JSON.stringify(generatedEvent(index))).join("\n") + "\n"
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, body, "utf8")
    },
    catch: (cause) => new InputFileError({ message: `Cannot generate ${path}`, cause })
  })
})

const normalize = (event: InputEvent): NewRawEvent => ({
  eventId: event.eventId,
  sourceId: event.source,
  eventType: event.eventType,
  occurredAt: new Date(event.occurredAt),
  occurredDay: event.occurredAt.slice(0, 10),
  amountUsd: Number((event.amount * FX[event.currency]).toFixed(2)),
  country: event.country.toUpperCase(),
  tags: [...new Set(event.tags.map((tag) => tag.toLowerCase()))],
  payload: event.payload
})

export const readInput = (path: string) => Effect.gen(function* () {
  const text = yield* Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => new InputFileError({ message: `Cannot read ${path}`, cause })
  })
  const lines = text.split("\n").filter((line) => line.length > 0)
  return yield* Effect.forEach(lines, (line, index) =>
    Effect.try({
      try: () => JSON.parse(line) as unknown,
      catch: (cause) => new InputRowError({ line: index + 1, message: "Invalid JSON", cause })
    }).pipe(
      Effect.flatMap(Schema.decodeUnknown(InputEvent)),
      Effect.map(normalize),
      Effect.mapError((cause) => cause instanceof InputRowError
        ? cause
        : new InputRowError({ line: index + 1, message: "Input does not match the event schema", cause }))
    ),
  { concurrency: 32 })
})
