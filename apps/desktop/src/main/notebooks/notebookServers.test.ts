import { EventEmitter } from "node:events"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { NotebookServers, stopNotebooksWithWindow } from "./notebookServers"

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
  servers = new NotebookServers({ start: 42_740, end: 42_759 }, 10_000, null, async (url) => {
    opened.push(url)
  })
})

afterEach(async () => {
  servers.dispose()
  await rm(dir, { recursive: true, force: true })
})

function startJupyter(serverId: string, env: NodeJS.ProcessEnv) {
  return startJupyterOn(servers, serverId, env)
}

function startJupyterOn(on: NotebookServers, serverId: string, env: NodeJS.ProcessEnv) {
  return on.start({
    serverId,
    tool: "jupyter",
    environment: {
      kind: "pi-lab",
      uvx,
      label: "PI Lab copy (uvx)",
      jupyterApp: "lab",
      fallbackReason: null,
    },
    cwd: dir,
    absPath: join(dir, "a.ipynb"),
    relPath: "a.ipynb",
    env: { ...process.env, PI_LAB_TEST_NOTEBOOK_MARKER: marker, ...env },
  })
}

async function startedPid(): Promise<number> {
  return markedPid("start:")
}

async function markedPid(prefix: string): Promise<number> {
  const line = (await readFile(marker, "utf8")).split("\n").find((l) => l.startsWith(prefix))
  return Number(line?.slice(prefix.length))
}

/** The marker file's text, or "" before the stand-in server wrote it. */
async function markerText(): Promise<string> {
  return readFile(marker, "utf8").catch(() => "")
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

  test("dispose stops every running server with SIGTERM, so it can shut down (app quit)", async () => {
    await startJupyter("quit", {})
    const pid = await startedPid()
    expect(servers.runningCount()).toBe(1)
    servers.dispose()
    await expect.poll(() => alive(pid)).toBe(false)
    expect(await readFile(marker, "utf8")).toContain(`stop:${pid}`)
  })

  test("a server that printed its URL but never answered fails at the timeout and is stopped", async () => {
    const quick = new NotebookServers({ start: 42_760, end: 42_769 }, 1_000, null, async () => {})
    await expect(
      startJupyterOn(quick, "silent", { PI_LAB_TEST_NOTEBOOK_LISTEN_DELAY_MS: "20000" }),
    ).rejects.toThrow("did not start within 1 seconds")
    const pid = await markedPid("launch:")
    await expect.poll(() => alive(pid)).toBe(false)
    expect(quick.urlOf("silent")).toBeNull()
    expect(quick.runningCount()).toBe(0)
  })

  test("dispose while a server is starting: no server is spawned after it", async () => {
    const starting = startJupyter("pending", {})
    servers.dispose()
    await expect(starting).rejects.toThrow("closed")
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    expect(await markerText()).not.toContain("launch:")
  })

  test("stopAll while a server is starting (window reload): it is not spawned, later starts work", async () => {
    const starting = startJupyter("before-reload", {})
    await servers.stopAll()
    await expect(starting).rejects.toThrow("closed")
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
    expect(await markerText()).not.toContain("launch:")
    const started = await startJupyter("after-reload", {})
    expect(servers.urlOf("after-reload")).toBe(started.url)
  })

  test("the window's reload, renderer crash and close stop every server; a frame navigation does not", async () => {
    const window = new EventEmitter()
    const contents = new EventEmitter()
    let stops = 0
    stopNotebooksWithWindow(window, contents, async () => {
      stops += 1
    })
    contents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false })
    contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true })
    expect(stops).toBe(0)
    contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
    contents.emit("render-process-gone", {}, { reason: "crashed" })
    window.emit("closed")
    await expect.poll(() => stops).toBe(3)
  })
})
