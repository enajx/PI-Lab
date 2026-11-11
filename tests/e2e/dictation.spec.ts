import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { createRequire } from "node:module"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Locator,
  type Page,
  test,
} from "./fixtures/playwright"

/**
 * Whole-app dictation: Chromium's fake microphone plays a "hello world" recording, the
 * dictation shortcut (sent as macOS Option+D, which types "∂") starts and stops
 * recording, the bundled whisper.cpp engine transcribes it with the tiny.en model, and
 * the text lands in a terminal (no Enter) and in an editor (one undo step).
 *
 * Needs the bundled engine (`bun run prepare:whisper` in apps/desktop) and the tiny.en
 * model cached by the engine test at `.cache/whisper-test-models` (at the repo root).
 * Playwright's Electron launcher must run under Node, not Bun.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, "..", "..")
const DESKTOP_DIR = join(REPO_ROOT, "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string
const TINY_MODEL = join(REPO_ROOT, ".cache", "whisper-test-models", "ggml-tiny.en.bin")
const ENGINE = join(DESKTOP_DIR, "resources", "whisper", `darwin-${process.arch}`, "whisper-server")
const SPEECH = join(DESKTOP_DIR, "src", "main", "dictation", "__fixtures__", "hello-world.wav")
const TERMINAL_MARKER = "E2E-DICTATION-READY"
const SEED_FILE = "notes.txt"
const SEED_CONTENT = "first line\n"

const execFileAsync = promisify(execFile)

/** A terminal that prints, hex-encoded, everything typed into it so far. */
const TERMINAL_PROBE: Record<string, string> = {
  PI_LAB_TEST_TERMINAL_CMD: process.execPath,
  PI_LAB_TEST_TERMINAL_ARGS: JSON.stringify([
    "-e",
    [
      `process.stdout.write('${TERMINAL_MARKER}\\n')`,
      "process.stdin.setRawMode?.(true)",
      "process.stdin.resume()",
      "let received = Buffer.alloc(0)",
      "process.stdin.on('data', chunk => { received = Buffer.concat([received, chunk]); process.stdout.write('\\r\\nE2E-INPUT-' + received.toString('hex') + '-END\\r\\n') })",
    ].join(";"),
  ]),
}
const CLIPBOARD_SENTINEL = "E2E-DICTATION-CLIPBOARD-SENTINEL"

test.skip(process.platform !== "darwin", "Dictation is macOS only")
test.skip(!existsSync(ENGINE), `No bundled whisper-server at ${ENGINE}`)
test.skip(!existsSync(TINY_MODEL), `No tiny.en model at ${TINY_MODEL}`)

// Starting the engine and loading the model the first time takes a while.
test.setTimeout(120_000)

let app: ElectronApplication
let dataDir: string
/** The local server standing in for Hugging Face, when a test starts one. */
let modelServer: Server | null = null
/** The user's clipboard text before a test that writes the clipboard, restored after it. */
let savedClipboard: string | null = null

test.afterEach(async () => {
  if (savedClipboard !== null) {
    const text = savedClipboard
    savedClipboard = null
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)
  }
  await app
    ?.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    })
    .catch(() => undefined)
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
  modelServer?.closeAllConnections()
  modelServer?.close()
  modelServer = null
})

/**
 * Start the app with a fake microphone that plays the speech fixture once and the cached
 * tiny.en model file installed under each of `modelFiles`, without waiting for the shell.
 * Each `brokenModels` entry (file name and the catalog's byte size) is installed as a file
 * of zeros: it counts as installed but the engine cannot load it.
 */
async function startApp(
  env: Record<string, string>,
  modelFiles: string[],
  brokenModels: Array<{ file: string; sizeBytes: number }>,
): Promise<Page> {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-dictation-"))
  const modelsDir = join(dataDir, "dictation", "models")
  await mkdir(modelsDir, { recursive: true })
  for (const name of modelFiles) await symlink(TINY_MODEL, join(modelsDir, name))
  for (const { file, sizeBytes } of brokenModels) {
    await writeFile(join(modelsDir, file), "")
    await truncate(join(modelsDir, file), sizeBytes)
  }
  const speech = join(dataDir, "speech.wav")
  await writeFile(speech, await withLeadingSilence(SPEECH, 0.6))
  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [
      MAIN_ENTRY,
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${speech}%noloop`,
      // The sandboxed audio service cannot read the fixture file.
      "--disable-features=AudioServiceSandbox",
    ],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      ...env,
    },
  })
  // The fake microphone needs no macOS permission; report it as allowed so no system prompt opens.
  await app.evaluate(({ systemPreferences }) => {
    systemPreferences.getMediaAccessStatus = () => "granted"
  })
  const window = await app.firstWindow()
  window.on("console", (message) => {
    if (message.type() === "error") console.log(`[renderer] ${message.text()}`)
  })
  return window
}

/** Start the app as {@link startApp} does, wait for the shell, and select tiny.en. */
async function launch(
  env: Record<string, string>,
  brokenModels: Array<{ file: string; sizeBytes: number }>,
): Promise<Page> {
  const window = await startApp(env, ["ggml-tiny.en.bin"], brokenModels)
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await useTinyModel(window)
  return window
}

/** Open Settings > Dictation. */
async function openDictationSettings(window: Page): Promise<void> {
  await window.keyboard.press("ControlOrMeta+,")
  await expect(window.getByTestId("settings-view")).toBeVisible({ timeout: 30_000 })
  await window.getByTestId("settings-nav-dictation").click()
}

/** Leave Settings for the shell. */
async function closeSettings(window: Page): Promise<void> {
  await window.getByTestId("settings-back").click()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
}

/** Choose what happens with the transcribed text in Settings > Dictation. */
async function setOutputAction(window: Page, action: string): Promise<void> {
  await openDictationSettings(window)
  const select = window.getByTestId("settings-dictation-output-action")
  await select.selectOption(action)
  await expect(select).toHaveValue(action)
  await closeSettings(window)
}

/** Select the pre-installed tiny.en model in Settings > Dictation, then go back. */
async function useTinyModel(window: Page): Promise<void> {
  await openDictationSettings(window)
  const tiny = window.locator('[data-testid="dictation-model"][data-model-key="tiny.en"]')
  await tiny.getByRole("button", { name: "Use" }).click()
  await expect(tiny).toContainText("In use")
  await closeSettings(window)
}

/** Press Option+D the way macOS sends it: Alt held, physical key D, character "∂". */
async function pressOptionD(window: Page): Promise<void> {
  const session = await window.context().newCDPSession(window)
  const key = { key: "∂", code: "KeyD", windowsVirtualKeyCode: 68, modifiers: 1 }
  await session.send("Input.dispatchKeyEvent", { type: "keyDown", text: "∂", ...key })
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...key })
  await session.detach()
}

/** Start dictation, let the fixture play, and stop with the shortcut. */
async function record(window: Page): Promise<void> {
  await pressOptionD(window)
  await expect(window.getByTestId("dictation-pill")).toHaveAttribute("data-phase", "listening", {
    timeout: 10_000,
  })
  await expect(window.getByTestId("dictation-wave")).toBeVisible()
  await window.waitForTimeout(2_500)
  await pressOptionD(window)
}

/** Dictate the fixture: record it and wait for the overlay to close. */
async function dictate(window: Page): Promise<void> {
  await record(window)
  await expect(window.getByTestId("dictation-pill")).toHaveCount(0, { timeout: 60_000 })
}

test("dictation types the transcribed text into the focused terminal without Enter", async () => {
  const window = await launch(TERMINAL_PROBE, [])
  const terminal = await focusTerminal(window)

  await dictate(window)

  await expect
    .poll(async () => latestTerminalInput((await terminal.textContent()) ?? ""), {
      timeout: 30_000,
    })
    .toMatch(/hello,? world/i)
  const typed = latestTerminalInput((await terminal.textContent()) ?? "")
  expect(typed).not.toContain("∂")
  expect(typed).not.toMatch(/[\r\n]/u)

  // The command palette's history picker inserts the entry into the terminal focused before it.
  await window.keyboard.press("ControlOrMeta+Shift+p")
  await window.getByTestId("command-palette-input").fill("Dictation history")
  await window.keyboard.press("Enter")
  await expect(window.getByTestId("quick-find-item").first()).toContainText(/hello,? world/i)
  await window.keyboard.press("Enter")
  await expect
    .poll(async () => latestTerminalInput((await terminal.textContent()) ?? ""), {
      timeout: 30_000,
    })
    .toMatch(/hello,? world.*hello,? world/i)
})

test("Space while listening stops and transcribes, and the space is not typed into the terminal", async () => {
  const window = await launch(TERMINAL_PROBE, [])
  const terminal = await focusTerminal(window)

  await pressOptionD(window)
  const pill = window.getByTestId("dictation-pill")
  await expect(pill).toHaveAttribute("data-phase", "listening", { timeout: 10_000 })
  await expect(pill.getByTitle("Press Enter to transcribe")).toHaveText("⏎")
  await expect(pill).not.toContainText("transcribe")
  await expect(pill).not.toContainText("⌥D")
  await expect(pill).not.toContainText("⎋")
  await window.waitForTimeout(2_500)
  await window.keyboard.press("Space")
  await expect(pill).not.toHaveAttribute("data-phase", "listening")
  await expect(pill).toHaveCount(0, { timeout: 60_000 })
  await expect
    .poll(async () => latestTerminalInput((await terminal.textContent()) ?? ""), {
      timeout: 30_000,
    })
    .toMatch(/hello,? world/i)
  expect(latestTerminalInput((await terminal.textContent()) ?? "")).toMatch(/^\S/u)
})

test("clicking the listening pill cancels the recording and opens Settings > Dictation", async () => {
  const window = await launch(TERMINAL_PROBE, [])
  await recordMicrophoneStreams(window)
  const terminal = await focusTerminal(window)

  await pressOptionD(window)
  const pill = window.getByTestId("dictation-pill")
  await expect(pill).toHaveAttribute("data-phase", "listening", { timeout: 10_000 })
  await pill.click()
  await expect(window.getByTestId("settings-section-dictation")).toBeVisible({ timeout: 10_000 })
  await expect(pill).toHaveCount(0)
  await expect.poll(() => liveMicrophoneTracks(window)).toEqual({ streams: 1, live: 0 })
  await closeSettings(window)
  expect(await terminal.textContent()).not.toContain("E2E-INPUT-")
})

test("the waveform style setting persists and changes the listening pill's waveform", async () => {
  const window = await launch(TERMINAL_PROBE, [])
  await focusTerminal(window)
  await pressOptionD(window)
  const wave = window.getByTestId("dictation-wave")
  await expect(wave).toHaveAttribute("data-style", "dots", { timeout: 10_000 })
  await window.keyboard.press("Escape")

  for (const style of ["ascii", "ascii-art", "bars"]) {
    await openDictationSettings(window)
    const select = window.getByTestId("settings-dictation-waveform-style")
    await select.selectOption(style)
    await expect(select).toHaveValue(style)
    await closeSettings(window)
    await openDictationSettings(window)
    await expect(window.getByTestId("settings-dictation-waveform-style")).toHaveValue(style)
    await closeSettings(window)
    await focusTerminal(window)
    await pressOptionD(window)
    await expect(wave).toHaveAttribute("data-style", style, { timeout: 10_000 })
    await window.keyboard.press("Escape")
  }
})

test("dictation inserts the transcribed text at the editor cursor as one undo step", async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-dictation-repo-"))
  await execFileAsync("git", ["init", "-b", "main", repoDir])
  await writeFile(join(repoDir, "README.md"), "# fixture\n")
  await writeFile(join(repoDir, SEED_FILE), SEED_CONTENT)
  const window = await launch({ PI_LAB_TEST_OPEN_PROJECT: repoDir }, [])
  await window.getByTestId("project-item").click()
  await window.getByTestId("panel-tab-files").click()
  await window.getByTestId("file-tree-file").filter({ hasText: SEED_FILE }).click()
  const buffer = window.getByTestId("editor-buffer")
  await buffer.locator(".cm-content").click()
  await window.keyboard.press("ControlOrMeta+End")

  await dictate(window)

  await expect(buffer.locator(".cm-content")).toContainText(/first line\s*hello,? world/i, {
    timeout: 30_000,
  })
  await expect(buffer.locator(".cm-content")).not.toContainText("∂")
  await window.keyboard.press("ControlOrMeta+z")
  await expect(buffer.locator(".cm-content")).not.toContainText(/hello/i)
  await expect(buffer.locator(".cm-content")).toContainText("first line")
  await rm(repoDir, { recursive: true, force: true })
})

test("review first shows the text in the pill for editing and Enter inserts the edited text", async () => {
  const window = await launch(TERMINAL_PROBE, [])
  await setOutputAction(window, "review")
  const terminal = await focusTerminal(window)

  await record(window)

  const pill = window.getByTestId("dictation-pill")
  await expect(pill).toHaveAttribute("data-phase", "review", { timeout: 60_000 })
  const field = window.getByTestId("dictation-review-text")
  await expect(field).toHaveValue(/hello,? world/i)
  await expect(field).toBeFocused()
  // Space types normally in the review text.
  await field.fill("edited by")
  await window.keyboard.press("Space")
  await window.keyboard.type("review")
  await expect(field).toHaveValue("edited by review")
  await window.keyboard.press("Enter")
  await expect(pill).toHaveCount(0)
  await expect
    .poll(async () => latestTerminalInput((await terminal.textContent()) ?? ""), {
      timeout: 30_000,
    })
    .toBe("edited by review")
})

test("copy and insert-copy output actions, then search, copy, delete and clear the history in Settings", async () => {
  const window = await launch(TERMINAL_PROBE, [])
  await saveClipboard()
  await setOutputAction(window, "copy")
  let terminal = await focusTerminal(window)

  // Copy to clipboard: the clipboard holds the text and nothing is typed in the terminal.
  await writeClipboard(CLIPBOARD_SENTINEL)
  await dictate(window)
  await expect.poll(readClipboard, { timeout: 10_000 }).toMatch(/hello,? world/i)
  expect(await terminal.textContent()).not.toContain("E2E-INPUT-")

  // Insert and copy: both.
  await setOutputAction(window, "insert-copy")
  terminal = await focusTerminal(window)
  await writeClipboard(CLIPBOARD_SENTINEL)
  await dictate(window)
  await expect
    .poll(async () => latestTerminalInput((await terminal.textContent()) ?? ""), {
      timeout: 30_000,
    })
    .toMatch(/hello,? world/i)
  await expect.poll(readClipboard, { timeout: 10_000 }).toMatch(/hello,? world/i)

  // Settings > Dictation history lists both dictations, newest first.
  await openDictationSettings(window)
  const history = window.getByTestId("settings-section-dictation-history")
  const entries = history.getByTestId("dictation-history-entry")
  await expect(entries).toHaveCount(2)
  await expect(entries.first()).toContainText(/hello,? world/i)

  const search = history.getByLabel("Search dictation history")
  await search.fill("no such words")
  await expect(entries).toHaveCount(0)
  await expect(history).toContainText("No matching dictations.")
  await search.fill("HELLO")
  await expect(entries).toHaveCount(2)
  await search.fill("")

  await writeClipboard(CLIPBOARD_SENTINEL)
  const first = entries.first()
  const copied = (await first.locator("p").textContent()) ?? ""
  await first.getByRole("button", { name: "Copy" }).click()
  await expect(first.getByRole("button", { name: "Copy" })).toHaveText("Copied")
  await expect.poll(readClipboard).toBe(copied)

  await first.getByRole("button", { name: "Delete" }).click()
  await expect(entries).toHaveCount(1)

  await history.getByRole("button", { name: "Clear all" }).click()
  await expect(history).toContainText("Delete all dictation history?")
  await history.getByRole("button", { name: "Cancel" }).click()
  await expect(entries).toHaveCount(1)
  await history.getByRole("button", { name: "Clear all" }).click()
  await history.getByRole("button", { name: "Delete all" }).click()
  await expect(entries).toHaveCount(0)
  await expect(history).toContainText("No dictations yet.")
})

test("shows the loading model pill while the engine loads (mocked slow engine health check)", async () => {
  const window = await launch(TERMINAL_PROBE, [])
  await window.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" })
  // Mocked: the engine's /health check answers 503 until released, so the model stays loading.
  await app.evaluate(() => {
    const real = globalThis.fetch
    const state = globalThis as typeof globalThis & { e2eHoldHealth?: boolean }
    state.e2eHoldHealth = true
    globalThis.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (state.e2eHoldHealth && /^http:\/\/127\.0\.0\.1:\d+\/health$/.test(url))
        return Promise.resolve(new Response("loading", { status: 503 }))
      return real(input, init)
    }
  })
  const terminal = await focusTerminal(window)

  await pressOptionD(window)
  const pill = window.getByTestId("dictation-pill")
  await expect(pill).toHaveAttribute("data-phase", "listening", { timeout: 10_000 })
  await window.waitForTimeout(2_500)
  await window.keyboard.press("Enter")
  await expect(pill).toHaveAttribute("data-phase", "loading")
  await expect(pill).toContainText("Loading model")
  await window.waitForTimeout(300)
  const box = await pill.boundingBox()
  if (!box) throw new Error("The dictation pill has no bounding box")
  await window.screenshot({
    path: test.info().outputPath("dictation-loading-light.png"),
    clip: { x: box.x - 160, y: box.y - 70, width: box.width + 320, height: box.height + 100 },
  })

  await app.evaluate(() => {
    ;(globalThis as typeof globalThis & { e2eHoldHealth?: boolean }).e2eHoldHealth = false
  })
  await expect(pill).toHaveCount(0, { timeout: 60_000 })
  await expect
    .poll(async () => latestTerminalInput((await terminal.textContent()) ?? ""), {
      timeout: 30_000,
    })
    .toMatch(/hello,? world/i)
})

test("the setup wizard's dictation install starts a download and shows progress (mocked model download)", async () => {
  const window = await startApp({ PI_LAB_TEST_FIRST_RUN: "1" }, ["ggml-tiny.en.bin"], [])
  await expect(window.getByTestId("first-run-setup")).toBeVisible({ timeout: 30_000 })
  // Mocked: model downloads from Hugging Face stream 1 MB chunks and never finish.
  await app.evaluate(() => {
    const real = globalThis.fetch
    globalThis.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (!url.startsWith("https://huggingface.co/")) return real(input, init)
      let timer: NodeJS.Timeout | undefined
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          let sent = 0
          timer = setInterval(() => {
            if (sent >= 100) return
            sent += 1
            controller.enqueue(new Uint8Array(1_000_000))
          }, 20)
          init?.signal?.addEventListener("abort", () => {
            clearInterval(timer)
            controller.error(new Error("aborted"))
          })
        },
        cancel() {
          clearInterval(timer)
        },
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    }
  })
  const section = window.getByTestId("first-run-dictation")
  await section.getByRole("button", { name: /^Install Small English \(\d+ MB\)$/ }).click()
  const progress = section.getByLabel("Speech model download")
  await expect(progress).toBeVisible()
  await expect(section).toContainText(/[1-9]\d* \/ \d+ MB/)
  await expect
    .poll(async () => Number(await progress.getAttribute("aria-valuenow")))
    .toBeGreaterThan(0)
  await expect(section.getByRole("button", { name: /^Install / })).toBeDisabled()
})

test("Esc while listening cancels: the microphone is released and nothing is inserted or saved", async () => {
  const window = await launch(TERMINAL_PROBE, [])
  await recordMicrophoneStreams(window)
  const terminal = await focusTerminal(window)

  await pressOptionD(window)
  const pill = window.getByTestId("dictation-pill")
  await expect(pill).toHaveAttribute("data-phase", "listening", { timeout: 10_000 })
  await window.waitForTimeout(2_500)
  await window.keyboard.press("Escape")
  await expect(pill).toHaveCount(0)

  await expect.poll(() => liveMicrophoneTracks(window)).toEqual({ streams: 1, live: 0 })
  await window.waitForTimeout(3_000)
  expect(await terminal.textContent()).not.toContain("E2E-INPUT-")
  await expectNoHistory(window)
})

test("Esc while transcribing drops the text: nothing is inserted or saved (mocked slow transcription)", async () => {
  const window = await launch(TERMINAL_PROBE, [])
  // Mocked: the engine's /inference request waits until released.
  await app.evaluate(() => {
    const real = globalThis.fetch
    const state = globalThis as typeof globalThis & { e2eHoldInference?: boolean }
    state.e2eHoldInference = true
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (/^http:\/\/127\.0\.0\.1:\d+\/inference$/.test(url)) {
        while (state.e2eHoldInference) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return real(input, init)
    }
  })
  const terminal = await focusTerminal(window)

  await record(window)
  const pill = window.getByTestId("dictation-pill")
  await expect(pill).toHaveAttribute("data-phase", "transcribing", { timeout: 60_000 })
  await window.keyboard.press("Escape")
  await expect(pill).toHaveCount(0)
  await app.evaluate(() => {
    ;(globalThis as typeof globalThis & { e2eHoldInference?: boolean }).e2eHoldInference = false
  })
  await window.waitForTimeout(5_000)
  expect(await terminal.textContent()).not.toContain("E2E-INPUT-")
  await expectNoHistory(window)
})

test("the shortcut in the review pill discards the text and starts a new dictation", async () => {
  const window = await launch(TERMINAL_PROBE, [])
  await setOutputAction(window, "review")
  const terminal = await focusTerminal(window)

  await record(window)
  const pill = window.getByTestId("dictation-pill")
  await expect(pill).toHaveAttribute("data-phase", "review", { timeout: 60_000 })
  await expect(window.getByTestId("dictation-review-text")).toHaveValue(/hello,? world/i)
  await pressOptionD(window)
  await expect(pill).toHaveAttribute("data-phase", "listening")
  await window.keyboard.press("Escape")
  await expect(pill).toHaveCount(0)
  expect(await terminal.textContent()).not.toContain("E2E-INPUT-")
})

test("first use without a model: Download Small English, then listening starts and the text arrives (mocked model download)", async () => {
  const window = await startApp({ ...TERMINAL_PROBE, ...(await smallEnglishPins()) }, [], [])
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await serveModelsLocally(false)
  const terminal = await focusTerminal(window)

  await pressOptionD(window)
  const pill = window.getByTestId("dictation-pill")
  await expect(pill).toHaveAttribute("data-phase", "prompt", { timeout: 10_000 })
  const download = window.getByTestId("dictation-download-recommended")
  await expect(download).toHaveText(/^Download Small English \(\d+ MB\)$/)
  await download.click()
  await expect(pill).toHaveAttribute("data-phase", "listening", { timeout: 60_000 })
  await window.waitForTimeout(2_500)
  await pressOptionD(window)
  await expect(pill).toHaveCount(0, { timeout: 60_000 })
  await expect
    .poll(async () => latestTerminalInput((await terminal.textContent()) ?? ""), {
      timeout: 30_000,
    })
    .toMatch(/hello,? world/i)
})

test("first use follows a Small English download already started in Settings (mocked model download)", async () => {
  const window = await startApp({ ...TERMINAL_PROBE, ...(await smallEnglishPins()) }, [], [])
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const release = await serveModelsLocally(true)
  await openDictationSettings(window)
  const small = window.locator('[data-testid="dictation-model"][data-model-key="small.en"]')
  await small.getByRole("button", { name: "Download" }).click()
  await expect(small.getByLabel("Small English download")).toBeVisible()
  await closeSettings(window)
  const terminal = await focusTerminal(window)

  await pressOptionD(window)
  const pill = window.getByTestId("dictation-pill")
  await expect(pill).toHaveAttribute("data-phase", "prompt", { timeout: 10_000 })
  await window.getByTestId("dictation-download-recommended").click()
  await expect(pill).toHaveAttribute("data-phase", "downloading")
  release()
  await expect(pill).toHaveAttribute("data-phase", "listening", { timeout: 60_000 })
  await window.waitForTimeout(2_500)
  await pressOptionD(window)
  await expect(pill).toHaveCount(0, { timeout: 60_000 })
  await expect
    .poll(async () => latestTerminalInput((await terminal.textContent()) ?? ""), {
      timeout: 30_000,
    })
    .toMatch(/hello,? world/i)
})

test("with no model selected, an installed Small English is selected and dictation starts", async () => {
  // Small English is pinned to the tiny.en file (test mode) and installed as that file.
  const window = await startApp(
    { ...TERMINAL_PROBE, ...(await smallEnglishPins()) },
    ["ggml-small.en.bin", "ggml-tiny.en.bin"],
    [],
  )
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const terminal = await focusTerminal(window)

  await dictate(window)
  await expect
    .poll(async () => latestTerminalInput((await terminal.textContent()) ?? ""), {
      timeout: 30_000,
    })
    .toMatch(/hello,? world/i)
  await openDictationSettings(window)
  await expect(
    window.locator('[data-testid="dictation-model"][data-model-key="small.en"]'),
  ).toContainText("In use")
})

test("a model that fails to load shows the engine's error in Settings and in the pill", async () => {
  // Base English, 147964211 bytes in the catalog, installed as a file of zeros.
  const window = await launch(TERMINAL_PROBE, [{ file: "ggml-base.en.bin", sizeBytes: 147964211 }])
  await focusTerminal(window)
  // Start the engine with tiny.en, then cancel; the engine keeps running.
  await pressOptionD(window)
  const pill = window.getByTestId("dictation-pill")
  await expect(pill).toHaveAttribute("data-phase", "listening", { timeout: 10_000 })
  await window.keyboard.press("Escape")

  await openDictationSettings(window)
  const base = window.locator('[data-testid="dictation-model"][data-model-key="base.en"]')
  await base.getByRole("button", { name: "Use" }).click()
  await expect(base).toContainText("In use")
  const engineError = window
    .getByTestId("settings-section-dictation")
    .getByRole("alert")
    .filter({ hasText: /dictation engine/ })
  await expect(engineError).toBeVisible({ timeout: 30_000 })
  const message = (await engineError.textContent()) ?? ""
  await closeSettings(window)
  await focusTerminal(window)

  await record(window)
  await expect(pill).toHaveAttribute("data-phase", "error", { timeout: 60_000 })
  await expect(pill).toContainText(/The dictation engine (stopped|did not finish)/)
  await expect(pill).not.toContainText("could not load the model")
  expect(message).toMatch(/The dictation engine (stopped|did not finish)/)
})

test("denied microphone access shows Open System Settings, which opens the microphone privacy pane (mocked permission)", async () => {
  const window = await startApp(TERMINAL_PROBE, ["ggml-tiny.en.bin"], [])
  // Mocked: macOS reports microphone access as denied, and opening URLs is recorded.
  await app.evaluate(({ shell, systemPreferences }) => {
    const state = globalThis as typeof globalThis & { e2eOpened?: string[] }
    state.e2eOpened = []
    systemPreferences.getMediaAccessStatus = () => "denied"
    shell.openExternal = async (url) => {
      state.e2eOpened?.push(url)
    }
  })
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  // Selecting the model in Settings also refetches the dictation status.
  await useTinyModel(window)
  await focusTerminal(window)

  await pressOptionD(window)
  const pill = window.getByTestId("dictation-pill")
  await expect(pill).toHaveAttribute("data-phase", "error", { timeout: 10_000 })
  await expect(pill).toContainText("microphone")
  await pill.getByRole("button", { name: "Open System Settings" }).click()
  await expect
    .poll(() =>
      app.evaluate(() => (globalThis as typeof globalThis & { e2eOpened?: string[] }).e2eOpened),
    )
    .toEqual(["x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"])
  await expect(pill).toHaveCount(0)
})

/** Test-mode catalog pins that make Small English match the cached tiny.en file. */
async function smallEnglishPins(): Promise<Record<string, string>> {
  const sizeBytes = (await stat(TINY_MODEL)).size
  const sha256 = createHash("sha256")
    .update(await readFile(TINY_MODEL))
    .digest("hex")
  return { PI_LAB_TEST_DICTATION_PINS: JSON.stringify({ "small.en": { sizeBytes, sha256 } }) }
}

/**
 * Mocked model download: serve the cached tiny.en file from a local server for every
 * model and point the main process's Hugging Face requests at it. With `hold`, the
 * response sends its first 1 MB and waits for the returned release call.
 */
async function serveModelsLocally(hold: boolean): Promise<() => void> {
  let release = (): void => {}
  const released = hold ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve()
  const { size } = await stat(TINY_MODEL)
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-length": String(size) })
    const head = createReadStream(TINY_MODEL, { end: 1_000_000 - 1 })
    head.on("end", () => {
      void released.then(() => createReadStream(TINY_MODEL, { start: 1_000_000 }).pipe(response))
    })
    head.pipe(response, { end: false })
  })
  modelServer = server
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  await app.evaluate((_electron, origin) => {
    const real = globalThis.fetch
    globalThis.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (!url.startsWith("https://huggingface.co/")) return real(input, init)
      return real(`${origin}${new URL(url).pathname}`, init)
    }
  }, `http://127.0.0.1:${port}`)
  return release
}

/** Keep every microphone stream the page opens, to check later that it was released. */
async function recordMicrophoneStreams(window: Page): Promise<void> {
  await window.evaluate(() => {
    const devices = navigator.mediaDevices
    const open = devices.getUserMedia.bind(devices)
    const state = window as typeof window & { e2eStreams?: MediaStream[] }
    state.e2eStreams = []
    devices.getUserMedia = async (constraints) => {
      const stream = await open(constraints)
      state.e2eStreams?.push(stream)
      return stream
    }
  })
}

async function liveMicrophoneTracks(window: Page): Promise<{ streams: number; live: number }> {
  return window.evaluate(() => {
    const streams = (window as typeof window & { e2eStreams?: MediaStream[] }).e2eStreams ?? []
    const live = streams.flatMap((stream) =>
      stream.getTracks().filter((track) => track.readyState === "live"),
    )
    return { streams: streams.length, live: live.length }
  })
}

/** Settings > Dictation history is empty. */
async function expectNoHistory(window: Page): Promise<void> {
  await openDictationSettings(window)
  const history = window.getByTestId("settings-section-dictation-history")
  await expect(history).toContainText("No dictations yet.")
  await expect(history.getByTestId("dictation-history-entry")).toHaveCount(0)
}

/** Focus the terminal probe once it is running and return it. */
async function focusTerminal(window: Page): Promise<Locator> {
  const terminal = window.getByTestId("terminal")
  await expect(terminal).toContainText(TERMINAL_MARKER, { timeout: 30_000 })
  await terminal.locator(".xterm-helper-textarea").focus()
  return terminal
}

/** Keep the user's clipboard text so afterEach can put it back. */
async function saveClipboard(): Promise<void> {
  savedClipboard = await readClipboard()
}

async function readClipboard(): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText())
}

async function writeClipboard(text: string): Promise<void> {
  await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)
}

/** The text the terminal probe last reported receiving, decoded from hex. */
function latestTerminalInput(text: string): string {
  const matches = Array.from(text.matchAll(/E2E-INPUT-([0-9a-f]+)-END/gu))
  const hex = matches.at(-1)?.[1]
  return hex ? Buffer.from(hex, "hex").toString("utf8") : ""
}

/** The 16-bit PCM WAV at `path` with `seconds` of silence before the speech. */
async function withLeadingSilence(path: string, seconds: number): Promise<Buffer> {
  const wav = await readFile(path)
  const sampleRate = wav.readUInt32LE(24)
  const blockAlign = wav.readUInt16LE(32)
  const dataStart = wav.indexOf("data") + 8
  const silence = Buffer.alloc(Math.round(sampleRate * seconds) * blockAlign)
  const data = Buffer.concat([silence, wav.subarray(dataStart)])
  const header = Buffer.from(wav.subarray(0, dataStart))
  header.writeUInt32LE(header.length - 8 + data.length, 4)
  header.writeUInt32LE(data.length, dataStart - 4)
  return Buffer.concat([header, data])
}
