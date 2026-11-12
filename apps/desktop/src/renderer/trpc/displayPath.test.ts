import { describe, expect, test } from "vitest"
import { displayPath } from "./displayPath"

describe("displayPath", () => {
  test("shows a path inside the home folder as ~/…", () => {
    expect(
      displayPath("/Users/enaj/code/PI-Lab/tests/test-projects/python-research", "/Users/enaj"),
    ).toBe("~/code/PI-Lab/tests/test-projects/python-research")
  })
  test("shows the home folder itself as ~", () => {
    expect(displayPath("/Users/enaj", "/Users/enaj")).toBe("~")
    expect(displayPath("/Users/enaj/", "/Users/enaj/")).toBe("~")
  })
  test("leaves paths outside the home folder unchanged", () => {
    expect(displayPath("/opt/work/project", "/Users/enaj")).toBe("/opt/work/project")
  })
  test("does not match a sibling folder that shares the home prefix", () => {
    expect(displayPath("/Users/enajx/code", "/Users/enaj")).toBe("/Users/enajx/code")
  })
  test("leaves the path unchanged while the home folder is unknown", () => {
    expect(displayPath("/Users/enaj/code", undefined)).toBe("/Users/enaj/code")
    expect(displayPath("/Users/enaj/code", "")).toBe("/Users/enaj/code")
  })
  test("handles Windows separators", () => {
    expect(displayPath("C:\\Users\\enaj\\code", "C:\\Users\\enaj")).toBe("~\\code")
  })
})
