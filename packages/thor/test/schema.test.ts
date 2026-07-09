import { describe, expect, expectTypeOf, it } from "vitest"
import { pg } from "@gilvandovieira/thor"
import type { Insert, Select, Update } from "@gilvandovieira/thor"
import { TableMeta, isTable, tableMeta } from "@gilvandovieira/thor/schema"

const users = pg.table("users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull().unique(),
  name: pg.text("name").notNull(),
  age: pg.integer("age").nullable(),
  createdAt: pg.timestamp("created_at").notNull().defaultNow()
})

const invoices = pg.table("invoices", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  subtotal: pg.integer("subtotal").notNull(),
  tax: pg.integer("tax").notNull().default(0),
  total: pg.integer("total").generatedAlwaysAs("subtotal + tax")
})

describe("schema-derived types (spec §5.1)", () => {
  it("derives nullable and non-null Select fields", () => {
    expectTypeOf<Select<typeof users>>().toEqualTypeOf<{
      readonly id: string
      readonly email: string
      readonly name: string
      readonly age: number | null
      readonly createdAt: Date
    }>()
  })

  it("requires only non-null Insert fields without defaults", () => {
    expectTypeOf<Insert<typeof users>>().toEqualTypeOf<{
      email: string
      name: string
      id?: string
      age?: number | null
      createdAt?: Date
    }>()
  })

  it("makes every non-generated Update field optional", () => {
    expectTypeOf<Update<typeof users>>().toEqualTypeOf<{
      id?: string
      email?: string
      name?: string
      age?: number | null
      createdAt?: Date
    }>()
  })

  it("keeps generated fields selectable but omits them from writes", () => {
    expectTypeOf<Select<typeof invoices>>().toEqualTypeOf<{
      readonly id: string
      readonly subtotal: number
      readonly tax: number
      readonly total: number | null
    }>()
    expectTypeOf<Insert<typeof invoices>>().toEqualTypeOf<{
      subtotal: number
      id?: string
      tax?: number
    }>()
    expectTypeOf<Update<typeof invoices>>().toEqualTypeOf<{
      id?: string
      subtotal?: number
      tax?: number
    }>()
  })
})

describe("column and table metadata", () => {
  it("records constraints, defaults, SQL names, and primary keys", () => {
    const meta = tableMeta(users)

    expect(meta).toMatchObject({
      name: "users",
      primaryKey: ["id"],
      indexes: [],
      columns: {
        id: {
          def: {
            name: "id",
            table: "users",
            dataType: "uuid",
            notNull: true,
            primaryKey: true,
            hasDefault: true,
            defaultValue: { kind: "random" }
          }
        },
        email: { def: { name: "email", table: "users", notNull: true, unique: true } },
        age: { def: { name: "age", table: "users", notNull: false } },
        createdAt: {
          def: {
            name: "created_at",
            table: "users",
            dataType: "timestamptz",
            defaultValue: { kind: "now" }
          }
        }
      }
    })
  })

  it("keeps builder steps immutable", () => {
    const base = pg.text("status")
    const configured = base.notNull().unique().default("active")

    expect(base.def).toMatchObject({ notNull: false, unique: false, hasDefault: false })
    expect(configured.def).toMatchObject({
      notNull: true,
      unique: true,
      hasDefault: true,
      defaultValue: { kind: "value", value: "active" }
    })
  })

  it("binds independent column copies to each table", () => {
    const sharedId = pg.uuid("id").primaryKey()
    const alpha = pg.table("alpha", { id: sharedId })
    const beta = pg.table("beta", { id: sharedId })

    expect(alpha.id).not.toBe(beta.id)
    expect(alpha.id.def.table).toBe("alpha")
    expect(beta.id.def.table).toBe("beta")
    expect(sharedId.def.table).toBe("")
  })

  it("identifies tables without exposing metadata as an enumerable column", () => {
    expect(isTable(users)).toBe(true)
    expect(isTable({ users })).toBe(false)
    expect(Object.keys(users)).toEqual(["id", "email", "name", "age", "createdAt"])
    expect(Object.prototype.propertyIsEnumerable.call(users, TableMeta)).toBe(false)
  })
})
