import { describe, expect, test } from "vitest"
import { detectLocalZotero } from "./zotero"

describe("detectLocalZotero", () => {
  test("reports a running local API before checking install locations", async () => {
    const checked: string[] = []
    const state = await detectLocalZotero(
      async () => new Response("[]", { status: 200 }),
      "darwin",
      "/Users/test",
      async (path) => {
        checked.push(path)
        return false
      },
    )

    expect(state).toBe("running")
    expect(checked).toEqual([])
  })

  test("distinguishes an installed-but-closed app from not found", async () => {
    const failedFetch = async (): Promise<Response> => {
      throw new Error("connection refused")
    }
    expect(
      await detectLocalZotero(failedFetch, "darwin", "/Users/test", async (path) =>
        Promise.resolve(path === "/Applications/Zotero.app"),
      ),
    ).toBe("installed")
    expect(
      await detectLocalZotero(failedFetch, "linux", "/home/test", async () =>
        Promise.resolve(false),
      ),
    ).toBe("not-found")
  })
})
