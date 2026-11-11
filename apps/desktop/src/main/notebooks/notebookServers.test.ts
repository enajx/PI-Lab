import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { NotebookServers } from "./notebookServers"

/** Stand-in server: prints its URL like jupyter/marimo and serves a page (see the fixture). */
const FIXTURE = resolve(__dirname, "../../../../../tests/e2e/fixtures/notebook-server.cjs")

let dir: string
let uvx: string
let marker: string
let servers: NotebookServers
let opened: string[]

beforeEach(async () => {
  opened = []
  dir = await mkdtemp(join(tmpdir(), "pi-lab-notebook-servers-"))
  marker = join(dir, "marker.log")
  // A stand-in `uvx` that runs the stand-in server with the arguments PI Lab passes.
  uvx = join(dir, "uvx")
  await writeFile(uvx, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`)
  await chmod(uvx, 0o755)
  servers = new NotebookServers({ start: 42_740, end: 42_759 }, 10_000, async (url) => {
    opened.push(url)
  })
})

afterEach(async () => {
  servers.dispose()
  await rm(dir, { recursive: true, force: true })
})

function startJupyter(serverId: string, env: NodeJS.ProcessEnv) {
  return servers.start({
    serverId,
    tool: "jupyter",
    environment: { kind: "pi-lab", uvx, label: "PI Lab copy (uvx)", jupyterApp: "lab" },
    cwd: dir,
    absPath: join(dir, "a.ipynb"),
    relPath: "a.ipynb",
    env: { ...process.env, PI_LAB_TEST_NOTEBOOK_MARKER: marker, ...env },
  })
}

async function startedPid(): Promise<number> {
  const line = (await readFile(marker, "utf8")).split("\n").find((l) => l.startsWith("start:"))
  return Number(line?.slice("start:".length))
}

/** True while the process exists; signal 0 only checks. */
function alive(pid: number): boolean {
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}

describe("NotebookServers", () => {
  test("starts a stand-in server, serves the notebook URL, and stop ends the process", async () => {
    const started = await startJupyter("one", {})
    expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:427[45]\d\/lab\/tree\/a\.ipynb\?token=/)
    expect(servers.urlOf("one")).toBe(started.url)
    const port = Number(new URL(started.url).port)
    expect(servers.servesPort(port)).toBe(true)
    const page = await fetch(started.url)
    expect(await page.text()).toContain("Stand-in notebook server")
    const pid = await startedPid()
    expect(alive(pid)).toBe(true)
    await servers.openInBrowser("one")
    expect(opened).toEqual([started.url])

    await servers.stop("one")
    expect(alive(pid)).toBe(false)
    expect(servers.urlOf("one")).toBeNull()
    expect(servers.servesPort(port)).toBe(false)
    expect(await readFile(marker, "utf8")).toContain(`stop:${pid}`)
  })

  test("waits until the server answers when it prints its URL before it listens (like marimo's sandbox)", async () => {
    const started = await startJupyter("early", { PI_LAB_TEST_NOTEBOOK_LISTEN_DELAY_MS: "800" })
    const page = await fetch(started.url)
    expect(page.ok).toBe(true)
  })

  test("a server that exits before printing its URL fails with its error output", async () => {
    await expect(
      startJupyter("bad", { PI_LAB_TEST_NOTEBOOK_FAIL: "No module named jupyterlab" }),
    ).rejects.toThrow("No module named jupyterlab")
  })

  test("dispose stops every running server (app quit)", async () => {
    await startJupyter("quit", {})
    const pid = await startedPid()
    servers.dispose()
    await expect.poll(() => alive(pid)).toBe(false)
  })
})
