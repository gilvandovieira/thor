/**
 * Shared benchmark fixtures (spec §15.5).
 *
 * @module bench/fixtures
 */
import { pg } from "../postgres/index.js"

/** Representative users table shared by builder and compiler benchmarks. */
export const users = pg.table("users", {
  id: pg.uuid("id").primaryKey().defaultRandom(),
  email: pg.text("email").notNull().unique(),
  name: pg.text("name").notNull(),
  age: pg.integer("age").nullable(),
  createdAt: pg.timestamp("created_at").notNull().defaultNow()
})
