import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import {
  buildMarimoLaunch,
  releaseLeaseIfCurrent,
  removeIfCurrent,
  resolveReportAsset,
} from "./interactive"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("buildMarimoLaunch", () => {
  test("uses the selected project runtime without a shell", () => {
    expect(
      buildMarimoLaunch(
        {
          source: "uv-project",
          displayName: "uv project",
          interpreterPath: null,
          runStrategy: {
            kind: "uv-project",
            command: "uv",
            argsPrefix: ["run", "python"],
          },
        },
        "/repo/analysis/live.py",
        30_004,
      ),
    ).toEqual({
      command: "uv",
      args: [
        "run",
        "python",
        "-m",
        "marimo",
        "run",
        "/repo/analysis/live.py",
        "--host",
        "127.0.0.1",
        "--port",
        "30004",
        "--headless",
        "--no-token",
      ],
    })
  })

  test("fails visibly when the project has no Python runtime", () => {
    expect(() =>
      buildMarimoLaunch(
        {
          source: null,
          displayName: "No virtual env",
          interpreterPath: null,
          runStrategy: { kind: "unavailable", command: null, argsPrefix: [] },
        },
        "/repo/live.py",
        41_000,
      ),
    ).toThrow("No Python runtime")
  })
})

describe("resolveReportAsset", () => {
  test("allows relative assets but rejects traversal and symlink escapes", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-lab-report-"))
    temporaryDirectories.push(parent)
    const root = join(parent, "report")
    const outside = join(parent, "secret.js")
    await mkdir(join(root, "assets"), { recursive: true })
    await writeFile(join(root, "assets", "chart.js"), "window.chartReady = true")
    await writeFile(outside, "secret")
    await symlink(outside, join(root, "assets", "linked.js"))

    await expect(resolveReportAsset(root, "assets/chart.js")).resolves.toMatch(
      /report\/assets\/chart\.js$/,
    )
    await expect(resolveReportAsset(root, "../secret.js")).rejects.toThrow("escapes")
    await expect(resolveReportAsset(root, "assets/linked.js")).rejects.toThrow("escapes")
  })
})

describe("removeIfCurrent", () => {
  test("a stale startup cannot remove the newer managed process", () => {
    const stale = { generation: 1 }
    const current = { generation: 2 }
    const managed = new Map([["owner", stale]])
    managed.set("owner", current)

    removeIfCurrent(managed, "owner", stale)
    expect(managed.get("owner")).toBe(current)

    removeIfCurrent(managed, "owner", current)
    expect(managed.has("owner")).toBe(false)
  })
})

describe("releaseLeaseIfCurrent", () => {
  test("a stale close cannot release the replacement preview lease", () => {
    const leases = new Map([["owner", "replacement"]])

    expect(releaseLeaseIfCurrent(leases, "owner", "stale")).toBe(false)
    expect(leases.get("owner")).toBe("replacement")

    expect(releaseLeaseIfCurrent(leases, "owner", "replacement")).toBe(true)
    expect(leases.has("owner")).toBe(false)
  })
})
