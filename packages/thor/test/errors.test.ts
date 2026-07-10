import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  CapabilityError,
  CompileError,
  ConstraintError,
  DecodeError,
  DriverError,
  GuardError,
  IrreversibleMigrationError,
  MigrationError,
  NotFoundError,
  ParameterError,
  RoutineError,
  RuntimeCapabilityError,
  TimeoutError,
  TooManyRowsError,
  TransactionError
} from "@gilvandovieira/thor"

// The frozen public tagged-error set (spec §22). Changing this list is a
// deliberate, reviewed public-API change.
const FROZEN_TAGS = [
  "CapabilityError",
  "CompileError",
  "ConstraintError",
  "DecodeError",
  "DriverError",
  "GuardError",
  "IrreversibleMigrationError",
  "MigrationError",
  "NotFoundError",
  "ParameterError",
  "RoutineError",
  "RuntimeCapabilityError",
  "TimeoutError",
  "TooManyRowsError",
  "TransactionError"
]

describe("Epic V3/V4 — frozen tagged error set (§22)", () => {
  it("every public error carries exactly its stable _tag", () => {
    const instances = [
      new CapabilityError({ capability: "insert.returning", dialect: "mysql", message: "" }),
      new RuntimeCapabilityError({ adapter: "x", runtime: "node", required: [], missing: [], message: "" }),
      new CompileError({ message: "" }),
      new DriverError({ message: "" }),
      new ConstraintError({ constraint: "u", kind: "unique", message: "" }),
      new DecodeError({ message: "" }),
      new ParameterError({ reason: "missing", message: "" }),
      new NotFoundError({ message: "" }),
      new TooManyRowsError({ count: 2, message: "" }),
      new GuardError({ guard: "g", message: "" }),
      new MigrationError({ message: "" }),
      new IrreversibleMigrationError({ message: "" }),
      new TransactionError({ message: "" }),
      new TimeoutError({ message: "" }),
      new RoutineError({ routine: "r", message: "" })
    ]
    expect([...new Set(instances.map((error) => error._tag))].sort()).toEqual(FROZEN_TAGS)
  })

  it("errors are catchable by tag with structured fields (§22)", async () => {
    const recovered = await Effect.runPromise(
      Effect.fail(new ConstraintError({ constraint: "users_email_key", kind: "unique", message: "dup" })).pipe(
        Effect.catchTag("ConstraintError", (error) => Effect.succeed(error.kind))
      )
    )
    expect(recovered).toBe("unique")
  })

  it("consolidated spec §22 names resolve to real tags (relation → GuardError)", () => {
    // Spec §22 lists RelationPlanningError; relations use GuardError with a relation-* guard.
    const guard = new GuardError({ guard: "relation-strategy", message: "unknown strategy" })
    expect(guard._tag).toBe("GuardError")
    expect(guard.guard.startsWith("relation-")).toBe(true)
  })
})
