import { Effect } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import {
  GuardError,
  defineRelations,
  many,
  one,
  pg,
  withRelations,
  type RelationDescriptor,
  type Select
} from "@gilvandovieira/thor"
import { FakeDatabaseLayer, FakeDriver } from "@gilvandovieira/thor/testing"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey(),
  email: pg.text("email").notNull().unique()
})

const posts = pg.table("posts", {
  id: pg.uuid("id").primaryKey(),
  userId: pg.uuid("user_id").references(() => users.id),
  title: pg.text("title").notNull()
})

const relations = defineRelations({
  users: {
    posts: many(posts, { fields: [users.id], references: [posts.userId] })
  },
  posts: {
    author: one(users, { fields: [posts.userId], references: [users.id] })
  }
})

const run = <A, E>(effect: Effect.Effect<A, E, import("@gilvandovieira/thor").Database>, driver: FakeDriver) =>
  Effect.runPromise(Effect.provide(effect, FakeDatabaseLayer(driver)))

describe("relation declarations (spec §13.2)", () => {
  it("retains a typed graph keyed by source table", () => {
    expect(relations).toMatchObject({
      _tag: "Relations",
      definitions: {
        users: { posts: { kind: "many", target: posts } },
        posts: { author: { kind: "one", target: users } }
      }
    })
    expectTypeOf(relations.definitions.users.posts).toMatchTypeOf<
      RelationDescriptor<"many", readonly [typeof users.id], typeof posts, readonly [typeof posts.userId]>
    >()
  })

  it("rejects relation fields owned by a different source", () => {
    expect(() => defineRelations({
      users: {
        invalid: many(posts, { fields: [posts.id], references: [posts.userId] })
      }
    })).toThrowError(GuardError)
  })

  it("requires relation declarations to match foreign-key metadata", () => {
    const comments = pg.table("comments", {
      id: pg.uuid("id").primaryKey(),
      userId: pg.uuid("user_id")
    })

    expect(() => defineRelations({
      comments: {
        author: one(users, { fields: [comments.userId], references: [users.id] })
      }
    })).toThrowError(/must match a source foreign key/)
  })
})

describe("relation planner (spec §13.3-13.4)", () => {
  it("batches query loading by distinct parent keys without N+1", async () => {
    const driver = new FakeDriver().enqueue(
      { rows: [
        { id: "u1", email: "one@example.com" },
        { id: "u2", email: "two@example.com" },
        { id: "u1", email: "duplicate@example.com" }
      ] },
      { rows: [
        { id: "p1", userId: "u1", title: "First" },
        { id: "p2", userId: "u2", title: "Second" }
      ] }
    )

    const rows = await run(withRelations(relations).relation(users).findMany({
      with: { posts: { strategy: "query" } }
    }), driver)

    expect(rows).toEqual([
      { id: "u1", email: "one@example.com", posts: [{ id: "p1", userId: "u1", title: "First" }] },
      { id: "u2", email: "two@example.com", posts: [{ id: "p2", userId: "u2", title: "Second" }] },
      { id: "u1", email: "duplicate@example.com", posts: [{ id: "p1", userId: "u1", title: "First" }] }
    ])
    expect(driver.calls).toHaveLength(2)
    expect(driver.calls[1]?.params).toEqual(["u1", "u2"])
    expectTypeOf(rows).toEqualTypeOf<ReadonlyArray<Select<typeof users> & {
      readonly posts: ReadonlyArray<Select<typeof posts>>
    }>>()
  })

  it("loads join relations through one ordinary IR query", async () => {
    const driver = new FakeDriver().enqueue({ rows: [
      {
        root__id: "u1",
        root__email: "one@example.com",
        rel_0__id: "p1",
        rel_0__userId: "u1",
        rel_0__title: "First"
      },
      {
        root__id: "u1",
        root__email: "one@example.com",
        rel_0__id: "p2",
        rel_0__userId: "u1",
        rel_0__title: "Second"
      }
    ] })

    const rows = await run(withRelations(relations).relation(users).findMany({
      with: { posts: { strategy: "join" } }
    }), driver)

    expect(rows).toEqual([{
      id: "u1",
      email: "one@example.com",
      posts: [
        { id: "p1", userId: "u1", title: "First" },
        { id: "p2", userId: "u1", title: "Second" }
      ]
    }])
    expect(driver.calls).toHaveLength(1)
    expect(driver.calls[0]?.sql).toContain("LEFT JOIN")
  })

  it("invokes a manual loader once with all distinct keys", async () => {
    const driver = new FakeDriver().enqueue({ rows: [
      { id: "u1", email: "one@example.com" },
      { id: "u2", email: "two@example.com" }
    ] })
    const observed: Array<ReadonlyArray<ReadonlyArray<unknown>>> = []

    const rows = await run(withRelations(relations).relation(users).findMany({
      with: {
        posts: {
          strategy: "manual",
          load: ({ keys }) => {
            observed.push(keys)
            return Effect.succeed([{ id: "p1", userId: "u1", title: "First" }])
          }
        }
      }
    }), driver)

    expect(observed).toEqual([[["u1"], ["u2"]]])
    expect(rows[0]?.posts).toEqual([{ id: "p1", userId: "u1", title: "First" }])
    expect(rows[1]?.posts).toEqual([])
    expect(driver.calls).toHaveLength(1)
  })

  it("rejects missing and unknown loading strategies before execution", async () => {
    const missing = withRelations(relations).relation(users).findMany({
      with: { posts: {} as { strategy: "query" } }
    })
    const driver = new FakeDriver()
    const error = await Effect.runPromise(Effect.flip(Effect.provide(missing, FakeDatabaseLayer(driver))))

    expect(error).toMatchObject({ _tag: "GuardError", guard: "relation-strategy" })
    expect(driver.calls).toEqual([])
  })

  it("matches parent and child rows on bigint keys (query and join)", async () => {
    const orgs = pg.table("orgs", { id: pg.bigint("id").primaryKey(), name: pg.text("name").notNull() })
    const teams = pg.table("teams", {
      id: pg.bigint("id").primaryKey(),
      orgId: pg.bigint("org_id").references(() => orgs.id),
      label: pg.text("label").notNull()
    })
    const graph = defineRelations({
      orgs: { teams: many(teams, { fields: [orgs.id], references: [teams.orgId] }) }
    })

    const queryDriver = new FakeDriver().enqueue(
      { rows: [{ id: 1n, name: "Acme" }, { id: 2n, name: "Beta" }] },
      { rows: [{ id: 10n, orgId: 1n, label: "Core" }] }
    )
    const queried = await run(withRelations(graph).relation(orgs).findMany({ with: { teams: { strategy: "query" } } }), queryDriver)
    expect(queried[0]).toMatchObject({ id: 1n, teams: [{ id: 10n, orgId: 1n }] })
    expect(queried[1]).toMatchObject({ id: 2n, teams: [] })

    const joinDriver = new FakeDriver().enqueue({ rows: [
      { root__id: 1n, root__name: "Acme", rel_0__id: 10n, rel_0__orgId: 1n, rel_0__label: "Core" }
    ] })
    const joined = await run(withRelations(graph).relation(orgs).findMany({ with: { teams: { strategy: "join" } } }), joinDriver)
    expect(joined[0]).toMatchObject({ id: 1n, teams: [{ id: 10n }] })
  })
})
