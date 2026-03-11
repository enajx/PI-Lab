import { expect, test } from "vitest"
import { SKIPPER } from "./index"

test("@skipper/shared package is wired", () => {
  expect(SKIPPER).toBe("skipper")
})
