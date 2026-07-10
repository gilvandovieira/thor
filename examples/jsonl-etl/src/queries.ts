import { Schema } from "effect"
import {
  asc,
  count,
  db,
  desc,
  eq,
  excluded,
  exists,
  gt,
  gte,
  lt,
  param,
  rowNumber,
  sql,
  sum
} from "@gilvandovieira/thor"
import { SQLiteDialect } from "@gilvandovieira/thor/sqlite"
import { EventPayload, EventTags, dailyMetrics, importRuns, rawEvents, sources } from "./schema.js"

export const UpsertRawEvent = db.insert(rawEvents).values({
  eventId: param("eventId", Schema.String),
  sourceId: param("sourceId", Schema.String),
  eventType: param("eventType", Schema.String),
  occurredAt: param("occurredAt", Schema.Date),
  occurredDay: param("occurredDay", Schema.String),
  amountUsd: param("amountUsd", Schema.Number),
  country: param("country", Schema.String),
  tags: param("tags", EventTags),
  payload: param("payload", EventPayload)
}).onConflictDoUpdate([rawEvents.eventId], {
  sourceId: excluded(rawEvents.sourceId),
  eventType: excluded(rawEvents.eventType),
  occurredAt: excluded(rawEvents.occurredAt),
  occurredDay: excluded(rawEvents.occurredDay),
  amountUsd: excluded(rawEvents.amountUsd),
  country: excluded(rawEvents.country),
  tags: excluded(rawEvents.tags),
  payload: excluded(rawEvents.payload)
}).run().compilePrepared(SQLiteDialect)

export const UpsertDailyMetric = db.insert(dailyMetrics).values({
  id: param("id", Schema.String),
  sourceId: param("sourceId", Schema.String),
  day: param("day", Schema.String),
  eventType: param("eventType", Schema.String),
  eventCount: param("eventCount", Schema.Number),
  highValueCount: param("highValueCount", Schema.Number),
  grossUsd: param("grossUsd", Schema.Number),
  refreshedAt: param("refreshedAt", Schema.Date)
}).onConflictDoUpdate([dailyMetrics.sourceId, dailyMetrics.day, dailyMetrics.eventType], {
  eventCount: excluded(dailyMetrics.eventCount),
  highValueCount: excluded(dailyMetrics.highValueCount),
  grossUsd: excluded(dailyMetrics.grossUsd),
  refreshedAt: excluded(dailyMetrics.refreshedAt)
}).run().compilePrepared(SQLiteDialect)

export const FinishImportRun = db.update(importRuns).set({
  status: param("status", Schema.String),
  rowsRead: param("rowsRead", Schema.Number),
  rowsLoaded: param("rowsLoaded", Schema.Number),
  finishedAt: param("finishedAt", Schema.Date)
}).where(eq(importRuns.id, param("runId", Schema.String))).run().compilePrepared(SQLiteDialect)

export const FindEvent = db.select({
  eventId: rawEvents.eventId,
  sourceId: rawEvents.sourceId,
  eventType: rawEvents.eventType,
  amountUsd: rawEvents.amountUsd,
  payload: rawEvents.payload
}).from(rawEvents)
  .where(eq(rawEvents.eventId, param("eventId", Schema.String)))
  .prepare("FindEventById")

export const groupedMetrics = db.select({
  sourceId: rawEvents.sourceId,
  day: rawEvents.occurredDay,
  eventType: rawEvents.eventType,
  eventCount: count(),
  grossUsd: sum(rawEvents.amountUsd)
}).from(rawEvents)
  .groupBy(rawEvents.sourceId, rawEvents.occurredDay, rawEvents.eventType)
  .having(gt(count(), 0))

export const highValueMetrics = db.select({
  sourceId: rawEvents.sourceId,
  day: rawEvents.occurredDay,
  eventType: rawEvents.eventType,
  highValueCount: count()
}).from(rawEvents)
  .where(gte(rawEvents.amountUsd, param("threshold", Schema.Number)))
  .groupBy(rawEvents.sourceId, rawEvents.occurredDay, rawEvents.eventType)

export const sourceRollup = db.select({
  source: sources.name,
  region: sources.region,
  events: count(rawEvents.eventId),
  grossUsd: sum(rawEvents.amountUsd)
}).from(sources)
  .join(rawEvents, eq(sources.id, rawEvents.sourceId))
  .groupBy(sources.name, sources.region)
  .having(gt(count(rawEvents.eventId), 100))
  .orderBy(asc(sources.name))

export const rankedDays = db.select({
  source: sources.name,
  day: dailyMetrics.day,
  eventType: dailyMetrics.eventType,
  grossUsd: dailyMetrics.grossUsd,
  rank: rowNumber().over({
    partitionBy: [dailyMetrics.sourceId],
    orderBy: [desc(dailyMetrics.grossUsd)]
  })
}).from(dailyMetrics)
  .join(sources, eq(dailyMetrics.sourceId, sources.id))
  .orderBy(asc(sources.name), desc(dailyMetrics.grossUsd))
  .limit(12)

const activeSources = db.cte(
  "active_sources",
  db.select({ id: sources.id, name: sources.name }).from(sources).where(eq(sources.active, true))
)

export const activeMetrics = db.select({
  source: activeSources.field("name"),
  day: dailyMetrics.day,
  events: dailyMetrics.eventCount
}).from(dailyMetrics)
  .join(activeSources, eq(dailyMetrics.sourceId, activeSources.field("id")))
  .orderBy(desc(dailyMetrics.eventCount))
  .limit(8)

const eventsForSource = db.select({ eventId: rawEvents.eventId })
  .from(rawEvents)
  .where(eq(rawEvents.sourceId, sources.id))

export const sourcesWithEvents = db.select({ id: sources.id, name: sources.name })
  .from(sources)
  .where(exists(eventsForSource))

const naSources = db.select({ id: sources.id, name: sources.name }).from(sources).where(eq(sources.region, "na"))
const growthSources = db.select({ id: sources.id, name: sources.name }).from(sources).where(eq(sources.region, "latam"))
export const selectedMarkets = naSources.union(growthSources).orderBy(asc(sources.name))

export const partnerEvents = db.select({
  eventId: rawEvents.eventId,
  eventType: rawEvents.eventType,
  payload: rawEvents.payload
}).from(rawEvents)
  .where(sql`json_extract(${rawEvents.payload}, '$.channel') = 'partner'`)
  .limit(5)

export const deleteStaleMetrics = db.delete(dailyMetrics)
  .where(lt(dailyMetrics.day, param("before", Schema.String)))
