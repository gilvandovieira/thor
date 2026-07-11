import { Schema } from "effect"
import { sqlite, type Insert, type Select, unsafeSql } from "@gilvandovieira/thor"

export const EventTags = Schema.Array(Schema.String)
export const EventPayload = Schema.Struct({
  channel: Schema.Literal("web", "mobile", "partner"),
  campaign: Schema.String,
  customerTier: Schema.Literal("free", "pro", "enterprise")
})

export type ImportRunStatus = "running" | "completed" | "failed"

export const sources = sqlite.table(
  "sources",
  {
    id: sqlite.text("id").primaryKey(),
    name: sqlite.text("name").notNull().unique(),
    region: sqlite.text("region").notNull(),
    active: sqlite.boolean("active").notNull().default(true),
    createdAt: sqlite.timestamp("created_at").notNull().defaultNow()
  },
  {
    indexes: [{ name: "sources_region_idx", columns: ["region"] }],
    checks: [{ name: "sources_region_check", expression: unsafeSql("region in ('na', 'eu', 'latam')") }]
  }
)

export const rawEvents = sqlite.table(
  "raw_events",
  {
    eventId: sqlite.text("event_id").primaryKey(),
    sourceId: sqlite.text("source_id").notNull(),
    eventType: sqlite.text("event_type").notNull(),
    occurredAt: sqlite.timestamp("occurred_at").notNull(),
    occurredDay: sqlite.text("occurred_day").notNull(),
    amountUsd: sqlite.real("amount_usd").notNull(),
    country: sqlite.text("country").notNull(),
    tags: sqlite.json("tags", EventTags).notNull(),
    payload: sqlite.json("payload", EventPayload).notNull(),
    importedAt: sqlite.timestamp("imported_at").notNull().defaultNow()
  },
  {
    indexes: [
      { name: "raw_events_source_day_idx", columns: ["sourceId", "occurredDay"] },
      { name: "raw_events_type_idx", columns: ["eventType"] }
    ],
    foreignKeys: [
      {
        name: "raw_events_source_fk",
        columns: ["sourceId"],
        references: { table: "sources", columns: ["id"] },
        onDelete: "restrict",
        onUpdate: "cascade"
      }
    ],
    checks: [
      { name: "raw_events_type_check", expression: unsafeSql("event_type in ('view', 'cart', 'purchase', 'refund')") },
      { name: "raw_events_amount_check", expression: unsafeSql("amount_usd >= 0") },
      { name: "raw_events_day_check", expression: unsafeSql("length(occurred_day) = 10") }
    ]
  }
)

export const dailyMetrics = sqlite.table(
  "daily_metrics",
  {
    id: sqlite.text("id").primaryKey(),
    sourceId: sqlite.text("source_id").notNull(),
    day: sqlite.text("day").notNull(),
    eventType: sqlite.text("event_type").notNull(),
    eventCount: sqlite.integer("event_count").notNull(),
    highValueCount: sqlite.integer("high_value_count").notNull(),
    grossUsd: sqlite.real("gross_usd").notNull(),
    refreshedAt: sqlite.timestamp("refreshed_at").notNull()
  },
  {
    uniqueConstraints: [
      {
        name: "daily_metrics_natural_key",
        columns: ["sourceId", "day", "eventType"]
      }
    ],
    indexes: [{ name: "daily_metrics_day_idx", columns: ["day"] }],
    foreignKeys: [
      {
        name: "daily_metrics_source_fk",
        columns: ["sourceId"],
        references: { table: "sources", columns: ["id"] },
        onDelete: "cascade"
      }
    ]
  }
)

export const importRuns = sqlite.table(
  "import_runs",
  {
    id: sqlite.uuid("id").primaryKey().defaultRandom(),
    fileName: sqlite.text("file_name").notNull(),
    status: sqlite.text("status").notNull(),
    rowsRead: sqlite.integer("rows_read").notNull().default(0),
    rowsLoaded: sqlite.integer("rows_loaded").notNull().default(0),
    startedAt: sqlite.timestamp("started_at").notNull().defaultNow(),
    finishedAt: sqlite.timestamp("finished_at").nullable()
  },
  {
    indexes: [{ name: "import_runs_started_idx", columns: ["startedAt"] }],
    checks: [
      { name: "import_runs_status_check", expression: unsafeSql("status in ('running', 'completed', 'failed')") }
    ]
  }
)

export const applicationSchema = [sources, rawEvents, dailyMetrics, importRuns] as const

export type NewRawEvent = Insert<typeof rawEvents>
export type DailyMetricRow = Select<typeof dailyMetrics>
