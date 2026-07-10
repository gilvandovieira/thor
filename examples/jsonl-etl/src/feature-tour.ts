import { Schema } from "effect"
import {
  Capabilities,
  MySQLDialect,
  PostgresDialect,
  SQLiteDialect,
  db,
  eq,
  excluded,
  param
} from "@gilvandovieira/thor"
import { planExpandContract } from "@gilvandovieira/thor/migrate"
import { defineFunction, defineProcedure, defineTableFunction } from "@gilvandovieira/thor/routine"
import { rawEvents, sources } from "./schema.js"

const integer = { dataType: "integer" as const, codec: Schema.Number }

export const featureTour = () => {
  const correlated = db.select({ eventId: rawEvents.eventId })
    .from(rawEvents)
    .where(eq(rawEvents.sourceId, sources.id))
    .as("matching_events")
  const lateral = db.select({ source: sources.name, eventId: correlated.field("eventId") })
    .from(sources)
    .lateralJoin(correlated)

  const mysqlUpsert = db.insert(sources).values({
    id: "store-demo",
    name: "Demo",
    region: "na",
    active: true
  }).onDuplicateKeyUpdate({ name: excluded(sources.name) })

  const doubleAmount = defineFunction("analytics.double_amount", {
    args: [integer],
    returns: integer,
    volatility: "immutable"
  })
  const generateSeries = defineTableFunction("public.generate_series", {
    args: { start: integer, stop: integer },
    returns: { value: integer },
    volatility: "immutable"
  }).call({ start: 1, stop: 3 }, "series")
  const cleanup = defineProcedure("maintenance.cleanup_events", {
    args: { before: { dataType: "text" as const, codec: Schema.String } },
    effects: { mutates: ["raw_events"], idempotency: "idempotent", requiresTransaction: true }
  })

  const routineQuery = db.select({ doubled: doubleAmount(rawEvents.amountUsd) }).from(rawEvents).limit(1)
  const seriesQuery = db.select({ value: generateSeries.field("value") }).from(generateSeries)
  const preparedShape = db.select({ eventId: rawEvents.eventId }).from(rawEvents)
    .where(eq(rawEvents.eventId, param("eventId", Schema.String)))
  const unsafeHotHandle = preparedShape.all().compileUnsafeHot(SQLiteDialect)

  return {
    runtime: Capabilities.detectRuntimeCapabilities(),
    sqliteCapabilities: {
      returning: Capabilities.statusOf(Capabilities.SQLiteCapabilities, "insert.returning"),
      windows: Capabilities.statusOf(Capabilities.SQLiteCapabilities, "select.windowFunctions"),
      routines: Capabilities.statusOf(Capabilities.SQLiteCapabilities, "routine.functionCall")
    },
    dialectSql: {
      sqlitePrepared: preparedShape.toSql(SQLiteDialect).sql,
      postgresLateral: lateral.toSql(PostgresDialect).sql,
      mysqlUpsert: mysqlUpsert.toSql(MySQLDialect).sql,
      postgresFunction: routineQuery.toSql(PostgresDialect).sql,
      postgresTableFunction: seriesQuery.toSql(PostgresDialect).sql,
      mysqlProcedure: cleanup.call({ before: "2026-01-01" }).toSql(MySQLDialect).sql
    },
    queryInspection: preparedShape.inspect(),
    compiledHandle: {
      cacheKey: unsafeHotHandle.cacheKey,
      cardinality: unsafeHotHandle.cardinality,
      capabilities: [...unsafeHotHandle.capabilities]
    },
    expandContractPlan: planExpandContract("events_payload_v2", {
      table: "raw_events",
      add: { name: "payload_v2", type: "json", nullable: true },
      backfillSql: "update raw_events set payload_v2 = payload",
      dropColumn: "payload"
    }).map((plan) => ({ id: plan.id, operation: plan.operations[0]?._tag }))
  }
}
