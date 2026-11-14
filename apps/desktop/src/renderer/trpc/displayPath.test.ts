import { describe, expect, test } from "vitest"
import { displayPath } from "./displayPath"

describe("displayPath", () => {
  test("shows a path inside the home folder as ~/…", () => {
    expect(
      displayPath("/Users/ada/code/PI-Lab/tests/test-projects/python-research", "/Users/ada"),
    ).toBe("~/code/PI-Lab/tests/test-projects/python-research")
  })
  test("shows the home folder itself as ~", () => {
    expect(displayPath("/Users/ada", "/Users/ada")).toBe("~")
    expect(displayPath("/Users/ada/", "/Users/ada/")).toBe("~")
  })
  test("leaves paths outside the home folder unchanged", () => {
    expect(displayPath("/opt/work/project", "/Users/ada")).toBe("/opt/work/project")
  })
  test("does not match a sibling folder that shares the home prefix", () => {
    expect(displayPath("/Users/adam/code", "/Users/ada")).toBe("/Users/adam/code")
  })
  test("leaves the path unchanged while the home folder is unknown", () => {
    expect(displayPath("/Users/ada/code", undefined)).toBe("/Users/ada/code")
    expect(displayPath("/Users/ada/code", "")).toBe("/Users/ada/code")
  })
  test("handles Windows separators", () => {
    expect(displayPath("C:\\Users\\ada\\code", "C:\\Users\\ada")).toBe("~\\code")
  })
})
