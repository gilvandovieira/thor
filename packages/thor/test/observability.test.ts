import { Cause, type Context, Effect, Exit, Layer, Schema, Tracer } from "effect"
import { describe, expect, it } from "vitest"
import {
  Database,
  DriverError,
  type DatabaseService,
  type Driver,
  type ObservabilityEvent,
  type QueryObservabilityEvent,
  db,
  eq,
  param,
  pg,
  withObservability
} from "@gilvandovieira/thor"
import { backfill, defineMigration, makeMigrator, type MigrationPlan } from "@gilvandovieira/thor/migrate"
import { SQLiteDialect } from "@gilvandovieira/thor/sqlite"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey(),
  email: pg.text("email").notNull()
})

const collectingTracer = (names: string[], exits: Array<Exit.Exit<unknown, unknown>> = []): Tracer.Tracer => {
  let nextId = 0
  return Tracer.make({
    context: (evaluate) => evaluate(),
    span: (name, parent, context, links, startTime, kind, options) => {
      names.push(name)
      let status: Tracer.SpanStatus = { _tag: "Started", startTime }
      const attributes = new Map(Object.entries(options?.attributes ?? {}))
      return {
        _tag: "Span",
        name,
        spanId: `span-${++nextId}`,
        traceId: "thor-observability-test",
        parent,
        context: context as Context.Context<never>,
        get status() {
          return status
        },
        attributes,
        links,
        sampled: true,
        kind,
        end: (endTime, exit) => {
          status = { _tag: "Ended", startTime, endTime, exit }
          exits.push(exit)
        },
        attribute: (key, value) => {
          attributes.set(key, value)
        },
        event: () => undefined,
        addLinks: () => undefined
      }
    }
  })
}

describe("Epic S observability", () => {
  it("emits complete value-independent query metadata and cache outcomes", async () => {
    const events: ObservabilityEvent[] = []
    const driver = new FakeDriver().enqueue({ rows: [{ id: "u1" }] }, { rows: [{ id: "u2" }] })
    const query = db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, param("email", Schema.String)))
    const layer = withObservability(db.withQueryCache(FakeDatabaseLayer(driver)), {
      onEvent: (event) => events.push(event)
    })

    await Effect.runPromise(
      Effect.provide(
        Effect.all([query.all({ email: "first@example.com" }), query.all({ email: "second@example.com" })], {
          concurrency: 1
        }),
        layer
      )
    )

    const queries = events.filter((event): event is QueryObservabilityEvent => event.kind === "query")
    expect(queries).toHaveLength(2)
    expect(queries[0]).toMatchObject({
      operation: "select",
      spanName: "thor.query.select.users",
      dialect: "postgres",
      tables: ["users"],
      compileCache: "miss",
      preparedCache: "miss",
      rowCount: 1
    })
    expect(queries[1]).toMatchObject({ compileCache: "hit", preparedCache: "hit", rowCount: 1 })
    expect(queries[0]!.queryHash).toBe(queries[1]!.queryHash)
    expect(queries[0]!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("tracks prepared reuse per driver and only after successful binding", async () => {
    const query = db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, param("email", Schema.String)))
    const firstEvents: ObservabilityEvent[] = []
    const secondEvents: ObservabilityEvent[] = []
    const firstLayer = withObservability(FakeDatabaseLayer(new FakeDriver().enqueue({ rows: [] })), {
      onEvent: (event) => firstEvents.push(event)
    })
    const secondLayer = withObservability(FakeDatabaseLayer(new FakeDriver().enqueue({ rows: [] })), {
      onEvent: (event) => secondEvents.push(event)
    })

    await Effect.runPromise(Effect.provide(query.all({ email: "a@example.com" }), firstLayer))
    await Effect.runPromise(Effect.provide(query.all({ email: "b@example.com" }), secondLayer))

    expect(firstEvents[0]).toMatchObject({ kind: "query", preparedCache: "miss" })
    expect(secondEvents[0]).toMatchObject({ kind: "query", preparedCache: "miss" })

    const bindingEvents: ObservabilityEvent[] = []
    const bindingLayer = withObservability(FakeDatabaseLayer(new FakeDriver().enqueue({ rows: [] })), {
      onEvent: (event) => bindingEvents.push(event)
    })
    await Effect.runPromiseExit(Effect.provide(query.all({} as { email: string }), bindingLayer))
    await Effect.runPromise(Effect.provide(query.all({ email: "valid@example.com" }), bindingLayer))

    expect(bindingEvents[0]).toMatchObject({ kind: "query", preparedCache: "not-used", errorTag: "ParameterError" })
    expect(bindingEvents[1]).toMatchObject({ kind: "query", preparedCache: "miss" })
  })

  it("never exposes parameter values by default and redacts them when requested", async () => {
    const secret = "secret-token-7c91"
    const defaultEvents: ObservabilityEvent[] = []
    const redactedEvents: ObservabilityEvent[] = []
    const query = db.select({ id: users.id }).from(users).where(eq(users.email, secret))

    await Effect.runPromise(
      Effect.provide(
        query.all(),
        withObservability(FakeDatabaseLayer(new FakeDriver().enqueue({ rows: [] })), {
          onEvent: (event) => defaultEvents.push(event)
        })
      )
    )
    await Effect.runPromise(
      Effect.provide(
        query.all(),
        withObservability(FakeDatabaseLayer(new FakeDriver().enqueue({ rows: [] })), {
          logSql: "summary",
          logParams: "redacted",
          onEvent: (event) => redactedEvents.push(event)
        })
      )
    )

    expect(JSON.stringify(defaultEvents)).not.toContain(secret)
    expect(JSON.stringify(redactedEvents)).not.toContain(secret)
    expect(JSON.stringify(redactedEvents)).toContain("[REDACTED]")
    expect(redactedEvents[0]).toMatchObject({ sql: "select users" })
  })

  it("includes raw parameters only through the visibly unsafe opt-in", async () => {
    const secret = "explicitly-unsafe-secret"
    const events: ObservabilityEvent[] = []
    const query = db.select({ id: users.id }).from(users).where(eq(users.email, secret))
    await Effect.runPromise(
      Effect.provide(
        query.all(),
        withObservability(FakeDatabaseLayer(new FakeDriver().enqueue({ rows: [] })), {
          logParams: "unsafe-full",
          onEvent: (event) => events.push(event)
        })
      )
    )
    expect(JSON.stringify(events)).toContain(secret)
  })

  it("records tagged failures without replacing the original error", async () => {
    const events: ObservabilityEvent[] = []
    const spanExits: Array<Exit.Exit<unknown, unknown>> = []
    const expected = new DriverError({ message: "disconnected" })
    const driver = new FakeDriver().enqueue({ error: expected })
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        db.select({ id: users.id }).from(users).all(),
        withObservability(FakeDatabaseLayer(driver), {
          tracing: true,
          onEvent: (event) => events.push(event)
        })
      ).pipe(Effect.withTracer(collectingTracer([], spanExits)))
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.failureOption(exit.cause)).toMatchObject({
        _tag: "Some",
        value: { _tag: "DriverError", message: "disconnected" }
      })
    }
    expect(events[0]).toMatchObject({ kind: "query", errorTag: "DriverError" })
    expect(spanExits).toHaveLength(1)
    expect(Exit.isSuccess(spanExits[0]!)).toBe(true)
  })

  it("does not copy credentials, driver messages, binary data, emails, or large JSON into default events", async () => {
    const secrets = {
      url: "postgres://admin:password@db.internal/app?token=secret-token",
      email: "private.person@example.com",
      binary: new Uint8Array([115, 101, 99, 114, 101, 116]),
      json: { token: "x".repeat(20_000) }
    }
    const events: ObservabilityEvent[] = []
    const driver = new FakeDriver().enqueue({
      error: new DriverError({ message: `connection failed: ${secrets.url}` })
    })
    await Effect.runPromiseExit(
      Effect.provide(
        db.select({ id: users.id }).from(users).where(eq(users.email, secrets.email)).all(),
        withObservability(FakeDatabaseLayer(driver), { onEvent: (event) => events.push(event) })
      )
    )

    const rendered = JSON.stringify(events)
    expect(rendered).not.toContain(secrets.url)
    expect(rendered).not.toContain(secrets.email)
    expect(rendered).not.toContain("secret-token")
    expect(rendered).not.toContain(JSON.stringify(secrets.binary))
    expect(rendered).not.toContain(secrets.json.token)
    expect(events[0]).toMatchObject({ errorTag: "DriverError" })
  })

  it("creates thor query and transaction spans with propagated transaction scope", async () => {
    const events: ObservabilityEvent[] = []
    const spanNames: string[] = []
    const driver = new FakeDriver().enqueue({}, { rows: [] }, {})
    const layer = withObservability(FakeDatabaseLayer(driver), {
      tracing: true,
      onEvent: (event) => events.push(event)
    })
    const program = db
      .transaction(db.select({ id: users.id }).from(users).all())
      .pipe(Effect.provide(layer), Effect.withTracer(collectingTracer(spanNames)))

    await Effect.runPromise(program)

    expect(spanNames).toContain("thor.query.select.users")
    expect(spanNames).toContain("thor.transaction.commit")
    const query = events.find((event): event is QueryObservabilityEvent => event.kind === "query")
    expect(query?.transactionId).toMatch(/^tx-/)
    expect(query?.transactionScope).toBe(1)
  })

  it("creates migration apply and drift spans", async () => {
    const spanNames: string[] = []
    const driver = new FakeDriver()
    const layer = withObservability(FakeDatabaseLayer(driver, { dialect: SQLiteDialect }), { tracing: true })
    const service = await Effect.runPromise(Effect.provide(makeMigrator(), layer))
    const plan: MigrationPlan = { id: "0001_observed", name: "observed", operations: [] }

    await Effect.runPromise(Effect.withTracer(service.apply(plan), collectingTracer(spanNames)))
    await Effect.runPromise(Effect.withTracer(service.drift(), collectingTracer(spanNames)))

    expect(spanNames).toContain("thor.migration.apply")
    expect(spanNames).toContain("thor.migration.drift")
  })

  it("propagates migration and transaction context into backfill queries", async () => {
    const events: ObservabilityEvent[] = []
    const journal: Array<Record<string, unknown>> = []
    const migrations = SQLiteDialect.migrations
    const readJournal = migrations.readJournal("_thor_migrations")
    const insertJournal = migrations.insertJournal("_thor_migrations")
    const driver: Driver = {
      runtime: { adapter: "observability-migration-test", required: [] },
      query: (sql) => Effect.succeed(sql === readJournal ? journal : []),
      execute: (sql, params) => {
        if (sql === insertJournal) {
          journal.push({
            id: params[0],
            name: params[1],
            checksum: params[2],
            applied_at: params[3],
            execution_time_ms: params[4]
          })
        }
        return Effect.succeed({ rowCount: 0 })
      }
    }
    const service: DatabaseService = {
      dialect: SQLiteDialect,
      driver,
      allowEmulation: false,
      preparedStatements: true
    }
    const layer = withObservability(Layer.succeed(Database, service), {
      onEvent: (event) => events.push(event)
    })
    const migration = defineMigration({
      id: "0001_backfill",
      name: "observed backfill",
      revision: "1",
      safety: "additive",
      up: backfill(db.select({ id: users.id }).from(users).all())
    })
    const migrator = await Effect.runPromise(Effect.provide(makeMigrator({ migrations: [migration] }), layer))

    await Effect.runPromise(migrator.up())

    const query = events.find((event): event is QueryObservabilityEvent => event.kind === "query")
    expect(query).toMatchObject({ migrationId: migration.id, transactionScope: 1 })
    expect(query?.transactionId).toMatch(/^tx-/)
  })
})
