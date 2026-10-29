import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  type CDPSession,
  type ElectronApplication,
  _electron as electron,
  expect,
  test,
} from "./fixtures/playwright"

/** Actual Electron rendering, pointer capture, preferences and Python editor flow. */
const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string
const WIDTH_KEY = "pi-lab.projectView.rightSidebarWidth"
const PY_FILE = "module.py"
const execFileAsync = promisify(execFile)

let app: ElectronApplication
let dataDir: string
let repoDir: string

interface FunctionCoverage {
  functionName: string
  ranges: Array<{ startOffset: number; endOffset: number; count: number }>
}

interface ScriptCoverage {
  scriptId: string
  url: string
  functions: FunctionCoverage[]
}

interface RenderCalls {
  markdownFunctions: number
  markdownCalls: number
  compartmentFunctions: number
  compartmentCalls: number
}

/** Locate real built functions by their body, retaining positive baseline evidence. */
async function takeRenderCalls(session: CDPSession): Promise<RenderCalls> {
  const coverage = (await session.send("Profiler.takePreciseCoverage")) as {
    result: ScriptCoverage[]
  }
  const calls: RenderCalls = {
    markdownFunctions: 0,
    markdownCalls: 0,
    compartmentFunctions: 0,
    compartmentCalls: 0,
  }
  for (const script of coverage.result) {
    if (!script.url.includes("/out/renderer/assets/")) continue
    const { scriptSource } = (await session.send("Debugger.getScriptSource", {
      scriptId: script.scriptId,
    })) as { scriptSource: string }
    for (const fn of script.functions) {
      const range = fn.ranges[0]
      if (!range) continue
      // V8 also reports the whole module as an unnamed function. Count only
      // the component function, whose generated name changes under minification.
      if (range.startOffset === 0 && range.endOffset === scriptSource.length) continue
      const body = scriptSource.slice(range.startOffset, range.endOffset)
      if (/["']data-testid["']\s*:\s*["']markdown["']/.test(body)) {
        calls.markdownFunctions += 1
        calls.markdownCalls += range.count
      }
      if (
        fn.functionName === "reconfigure" &&
        /return\s+\w+\.reconfigure\.of\(\{\s*compartment:/.test(body)
      ) {
        calls.compartmentFunctions += 1
        calls.compartmentCalls += range.count
      }
    }
  }
  return calls
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-project-rendering-"))
  repoDir = join(dataDir, "repo")
  await execFileAsync("git", ["init", "-b", "main", repoDir])
  await execFileAsync("git", ["-C", repoDir, "config", "user.email", "test@pi-lab.local"])
  await execFileAsync("git", ["-C", repoDir, "config", "user.name", "PI Lab Test"])
  await writeFile(join(repoDir, "RESEARCH.md"), "# Rendering fixture\n\n- [x] Ready\n")
  await writeFile(join(repoDir, PY_FILE), "def main():\n    return 1\n")
  await execFileAsync("git", ["-C", repoDir, "add", "."])
  await execFileAsync("git", ["-C", repoDir, "commit", "-m", "initial"])
  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: repoDir,
      PI_LAB_TEST_AGENT_ID: "test-echo",
    },
  })
})

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("sidebar drag persists once and Python typing preserves Markdown and lint configuration", async () => {
  const testInfo = test.info()
  test.setTimeout(60_000)
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const session = await window.context().newCDPSession(window)
  await session.send("Debugger.enable")
  await session.send("Profiler.enable")
  await session.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true })
  await window.getByTestId("project-item").click()
  await expect(window.getByTestId("panel-tab-files")).toHaveAttribute("aria-selected", "true")
  await window.getByTestId("file-tree-file").filter({ hasText: PY_FILE }).click()
  const buffer = window.getByTestId("editor-buffer")
  await expect(buffer).toContainText("return 1")
  await window.getByTestId("panel-tab-research").click()
  await expect(window.getByRole("heading", { name: "Rendering fixture" })).toBeVisible()
  const initialCalls = await takeRenderCalls(session)
  expect(initialCalls.markdownFunctions).toBe(1)
  expect(initialCalls.markdownCalls).toBeGreaterThan(0)
  expect(initialCalls.compartmentFunctions).toBe(1)
  expect(initialCalls.compartmentCalls).toBeGreaterThan(0)

  await buffer.locator(".cm-content").click()
  await window.keyboard.press("ControlOrMeta+End")
  await window.keyboard.type("\n# typed while Research stays visible\n", { delay: 20 })
  await expect(buffer).toContainText("typed while Research stays visible")
  await expect(window.getByTestId("central-tab-dirty")).toBeVisible()
  // Read after a renderer frame so React effects from the last keystroke have run.
  await window.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  )
  const typingCalls = await takeRenderCalls(session)
  // V8 omits inactive functions after resetting coverage. The positive initial
  // counts above prove both targets were observed in this same renderer session.
  expect(typingCalls.markdownCalls).toBe(0)
  expect(typingCalls.compartmentCalls).toBe(0)
  await session.send("Profiler.stopPreciseCoverage")
  await session.detach()
  await window.keyboard.press("ControlOrMeta+s")
  await expect(window.getByTestId("central-tab-dirty")).toHaveCount(0)

  // Observe real preference writes without replacing the actual persistence behavior.
  await window.evaluate((widthKey) => {
    const state = globalThis as typeof globalThis & { __renderingWidthWrites: string[] }
    state.__renderingWidthWrites = []
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (this === localStorage && key === widthKey) state.__renderingWidthWrites.push(value)
      original.call(this, key, value)
    }
  }, WIDTH_KEY)
  const handle = window.getByTestId("right-sidebar-edge-drag")
  const sidebar = window.getByTestId("right-sidebar")
  const beforeWidth = await sidebar.evaluate((element) => element.getBoundingClientRect().width)
  const box = await handle.boundingBox()
  expect(box).not.toBeNull()
  if (!box) throw new Error("Sidebar resize handle has no bounding box")
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await window.mouse.move(x, y)
  await window.mouse.down()
  await window.mouse.move(x - 60, y, { steps: 12 })
  await expect
    .poll(() => sidebar.evaluate((element) => element.getBoundingClientRect().width))
    .toBe(beforeWidth + 60)
  const duringWrites = await window.evaluate(
    () =>
      (globalThis as typeof globalThis & { __renderingWidthWrites: string[] })
        .__renderingWidthWrites,
  )
  expect(duringWrites).toEqual([])
  await window.mouse.up()
  const finalWidth = beforeWidth + 60
  await expect
    .poll(() => window.evaluate((key) => localStorage.getItem(key), WIDTH_KEY))
    .toBe(String(finalWidth))
  const afterWrites = await window.evaluate(
    () =>
      (globalThis as typeof globalThis & { __renderingWidthWrites: string[] })
        .__renderingWidthWrites,
  )
  expect(afterWrites).toEqual([String(finalWidth)])
  const evidence = { initialCalls, typingCalls, duringWrites, afterWrites, finalWidth }
  console.info("Project rendering checks:", JSON.stringify(evidence))
  await testInfo.attach("rendering-call-counts", {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  })
  await window.reload()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("right-sidebar")).toBeVisible()
  await expect
    .poll(() =>
      window
        .getByTestId("right-sidebar")
        .evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBe(finalWidth)
})
