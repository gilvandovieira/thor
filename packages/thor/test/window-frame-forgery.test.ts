import { describe, expect, it } from "vitest"
import {
  currentRow,
  following,
  preceding,
  rowNumber,
  rowsBetween,
  unboundedFollowing,
  unboundedPreceding
} from "@gilvandovieira/thor"

describe("window frame runtime grammar", () => {
  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid offset %s", (offset) => {
    expect(() => preceding(offset)).toThrow(RangeError)
    expect(() => following(offset)).toThrow(RangeError)
  })

  it("rejects SQL-invalid unbounded endpoints", () => {
    expect(() => rowsBetween(unboundedFollowing, unboundedFollowing)).toThrow(RangeError)
    expect(() => rowsBetween(unboundedPreceding, unboundedPreceding)).toThrow(RangeError)
  })

  it.each([null, false, 0, ""])("does not silently discard a forged falsy frame %#", (frame) => {
    expect(() => rowNumber().over({ frame: frame as never })).toThrow(TypeError)
  })

  it("rejects forged reversed boundaries", () => {
    expect(() =>
      rowNumber().over({
        frame: {
          _tag: "WindowFrame",
          unit: "rows",
          start: { _tag: "Following", offset: 10 },
          end: { _tag: "Preceding", offset: 10 }
        } as never
      })
    ).toThrow(RangeError)
    expect(() => rowsBetween(currentRow, preceding(1))).toThrow(RangeError)
  })
})
