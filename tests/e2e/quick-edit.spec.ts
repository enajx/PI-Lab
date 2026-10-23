import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

const here = dirname(fileURLToPath(import.meta.url))
const desktop = join(here, "..", "..", "apps", "desktop")
const mainEntry = join(desktop, "out", "main", "index.js")
const electronPath = createRequire(join(desktop, "package.json"))("electron") as string
const packagedBinary =
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: Isolated package test override, not a build input.
  process.env.PI_LAB_PACKAGED_BINARY ??
  join(
    desktop,
    "release",
    "alpha",
    "mac-arm64",
    "PI Lab Alpha.app",
    "Contents",
    "MacOS",
    "PI Lab Alpha",
  )

test("packaged quick and full views share the Vim choice", async () => {
  test.skip(!existsSync(packagedBinary), "Packaged app is unavailable")
  test.setTimeout(120_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-packaged-vim-"))
  const filePath = join(dataDir, "scratch.py")
  await writeFile(filePath, "value = 1\n")
  let app: ElectronApplication | null = null
  try {
    const env = {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: join(dataDir, "app-data"),
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
    }
    app = await electron.launch({ executablePath: packagedBinary, args: [filePath], env })
    let window = await app.firstWindow()
    await expect(window.getByTestId("quick-editor").locator(".cm-content")).toContainText(
      "value = 1",
      { timeout: 30_000 },
    )
    await window.getByRole("button", { name: "Vim mode" }).click()
    await window.getByRole("button", { name: "Open PI Lab" }).click()
    await expect(window.getByTestId("quick-editor-full-app")).toBeVisible({ timeout: 30_000 })
    await window.getByTestId("nav-settings").click()
    await window.getByTestId("settings-nav-editor").click()
    await expect(window.getByTestId("settings-editor-vim")).toHaveAttribute("data-checked", "true")
    await window.getByTestId("settings-editor-vim").click()
    await expect(window.getByTestId("settings-editor-vim")).toHaveAttribute("data-checked", "false")
    await app.close()
    app = await electron.launch({ executablePath: packagedBinary, args: [filePath], env })
    window = await app.firstWindow()
    await expect(window.getByTestId("quick-editor").locator(".cm-content")).toContainText(
      "value = 1",
      { timeout: 30_000 },
    )
    await expect(window.getByRole("button", { name: "Vim mode" })).toHaveAttribute(
      "aria-pressed",
      "false",
    )
    await window.getByRole("button", { name: "Open PI Lab" }).click()
    await window.getByTestId("nav-settings").click()
    await window.getByTestId("settings-nav-editor").click()
    await window.getByTestId("settings-editor-vim").click()
    await expect(window.getByTestId("settings-editor-vim")).toHaveAttribute("data-checked", "true")
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-lab.editor.vim")))
      .toBe("true")
    await window.evaluate(() => localStorage.removeItem("pi-lab.editor.vim"))
    await app.close()
    app = await electron.launch({ executablePath: packagedBinary, args: [filePath], env })
    window = await app.firstWindow()
    await expect(window.getByTestId("quick-editor").locator(".cm-content")).toContainText(
      "value = 1",
      { timeout: 30_000 },
    )
    await expect(window.getByRole("button", { name: "Vim mode" })).toHaveAttribute(
      "aria-pressed",
      "true",
      { timeout: 30_000 },
    )
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("quick editor footer shows language, cursor, and a shared Vim choice", async () => {
  test.setTimeout(120_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-quick-footer-"))
  const filePath = join(dataDir, "scratch.py")
  await writeFile(filePath, "first = 1\nsecond = 2\n")
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry, filePath],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: join(dataDir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      },
    })
    const window = await app.firstWindow()
    const quick = window.getByTestId("quick-editor")
    const editor = quick.locator(".cm-content")
    const footer = quick.getByTestId("quick-editor-status-bar")
    await expect(editor).toContainText("second = 2", { timeout: 30_000 })
    await expect(footer).toContainText("Python")
    await expect(footer.getByTestId("quick-editor-cursor")).toHaveText("Ln 1, Col 1")
    await editor.press("ArrowDown")
    await editor.press("End")
    await expect(footer.getByTestId("quick-editor-cursor")).toHaveText("Ln 2, Col 11")
    await footer.getByRole("button", { name: "Vim mode" }).click()
    await expect(footer.getByRole("button", { name: "Vim mode" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await expect(editor).toBeFocused()
    await editor.press("i")
    await editor.press("Z")
    await expect(editor).toContainText("second = 2Z")
    await window.getByRole("button", { name: "Open PI Lab" }).click()
    await expect(window.getByTestId("quick-editor-full-app")).toBeVisible({ timeout: 30_000 })
    await expect(
      window.getByTestId("quick-editor-full-app").getByRole("button", { name: "Vim mode" }),
    ).toHaveAttribute("aria-pressed", "true")
    await window.getByTestId("nav-settings").click()
    await window.getByTestId("settings-nav-editor").click()
    await expect(window.getByTestId("settings-editor-vim")).toHaveAttribute("data-checked", "true")
    await window.getByTestId("settings-editor-vim").click()
    await expect(window.getByTestId("settings-editor-vim")).toHaveAttribute("data-checked", "false")
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem("pi-lab.editor.vim")))
      .toBe("false")
    await app.close()
    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry, filePath],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: join(dataDir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      },
    })
    const reopened = await app.firstWindow()
    await expect(reopened.getByTestId("quick-editor").locator(".cm-content")).toContainText(
      "second = 2Z",
      { timeout: 30_000 },
    )
    await expect(reopened.getByRole("button", { name: "Vim mode" })).toHaveAttribute(
      "aria-pressed",
      "false",
    )
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("quick editor footer switches Markdown render and source views", async () => {
  test.setTimeout(60_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-quick-markdown-"))
  const filePath = join(dataDir, "notes.md")
  await writeFile(filePath, "# Heading\n\nSome **bold** text.\n")
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry, filePath],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: join(dataDir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      },
    })
    const window = await app.firstWindow()
    const quick = window.getByTestId("quick-editor")
    const footer = quick.getByTestId("quick-editor-status-bar")
    await expect(quick.locator(".cm-content")).toContainText("Heading", { timeout: 30_000 })
    await expect(footer).toContainText("Markdown")
    await footer.getByRole("button", { name: "Render Markdown" }).click()
    await expect(footer.getByRole("button", { name: "Render Markdown" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await expect(quick.locator(".cm-md-heading-1")).toHaveCount(1)
    await expect(quick.locator(".cm-content")).toBeFocused()
    await footer.getByRole("button", { name: "Source Markdown" }).click()
    await expect(footer.getByRole("button", { name: "Source Markdown" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await expect(quick.locator(".cm-md-heading-1")).toHaveCount(0)
    await expect(quick.locator(".cm-content")).toBeFocused()
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

/** Check the settings handoff in development and the packaged app. */
async function checkQuickSettingsHandoff(packaged: boolean): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-quick-settings-link-"))
  const filePath = join(dataDir, "script.py")
  await writeFile(filePath, "print('before')\n")
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: packaged ? packagedBinary : electronPath,
      args: packaged ? [filePath] : [mainEntry, filePath],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: join(dataDir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      },
    })
    const window = await app.firstWindow()
    const editor = window.getByTestId("quick-editor").locator(".cm-content")
    await expect(editor).toContainText("before", { timeout: 30_000 })
    await editor.press("ControlOrMeta+End")
    await window.keyboard.type("# saved before settings")
    await expect(window.getByTestId("quick-editor-settings")).toBeVisible({ timeout: 5_000 })
    await window.getByTestId("quick-editor-settings").click()
    await expect(window.getByTestId("settings-section-quick-editor")).toBeVisible()
    expect(await readFile(filePath, "utf8")).toContain("# saved before settings")
    await window.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="settings-back"]')?.click()
    })
    await expect(window.getByTestId("quick-editor-full-app")).toBeVisible()
    await expect(window.getByTestId("quick-editor-header-filename")).toHaveText("script.py")
    await expect(window.getByTestId("quick-editor-full-app").locator(".cm-content")).toContainText(
      "# saved before settings",
    )
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}

test("Quick Editor settings icon opens its settings and Back returns to the same file", async () => {
  test.setTimeout(90_000)
  await checkQuickSettingsHandoff(false)
})

test("packaged Quick Editor settings returns to the same file", async () => {
  test.skip(!existsSync(packagedBinary), "Packaged app is unavailable")
  test.setTimeout(90_000)
  await checkQuickSettingsHandoff(true)
})

test("Quick Editor Settings controls word autocomplete and the default Markdown view", async () => {
  test.setTimeout(120_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-quick-settings-"))
  const filePath = join(dataDir, "notes.md")
  await writeFile(filePath, "# Heading\n\nalphaVariable\nalp")
  let app: ElectronApplication | null = null
  const env = {
    ...process.env,
    PI_LAB_TEST_MODE: "1",
    PI_LAB_DATA_DIR: join(dataDir, "app-data"),
    PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
  }
  try {
    app = await electron.launch({ executablePath: electronPath, args: [mainEntry, filePath], env })
    let window = await app.firstWindow()
    const quick = window.getByTestId("quick-editor")
    await expect(quick.locator(".cm-content")).toContainText("alphaVariable", {
      timeout: 30_000,
    })
    await expect(quick.locator(".cm-md-heading-1")).toHaveCount(0)
    await quick.locator(".cm-content").press("ControlOrMeta+End")
    await quick.locator(".cm-content").press("Control+Space")
    await window.waitForTimeout(200)
    await expect(quick.locator(".cm-tooltip-autocomplete")).toHaveCount(0)

    await window.getByRole("button", { name: "Open PI Lab" }).click()
    await window.getByTestId("nav-settings").click()
    await window.getByTestId("settings-nav-quick-editor").click()
    await expect(window.getByTestId("settings-quick-editor-vim")).toBeVisible()
    await expect(window.getByTestId("settings-quick-editor-autocomplete")).toHaveAttribute(
      "data-checked",
      "false",
    )
    await window.getByTestId("settings-quick-editor-autocomplete").click()
    await window.getByTestId("settings-quick-editor-markdown-view").selectOption("render")
    await app.close()

    app = await electron.launch({ executablePath: electronPath, args: [mainEntry, filePath], env })
    window = await app.firstWindow()
    const reopened = window.getByTestId("quick-editor")
    await expect(reopened.locator(".cm-content")).toContainText("alphaVariable", {
      timeout: 30_000,
    })
    await expect(reopened.locator(".cm-md-heading-1")).toHaveCount(1)
    await reopened.locator(".cm-content").press("ControlOrMeta+End")
    await reopened.locator(".cm-content").press("Control+Space")
    await expect(reopened.locator(".cm-tooltip-autocomplete")).toContainText("alphaVariable")
    await reopened.getByRole("button", { name: "Source Markdown" }).click()
    await expect(reopened.locator(".cm-md-heading-1")).toHaveCount(0)
    await app.close()

    app = await electron.launch({ executablePath: electronPath, args: [mainEntry, filePath], env })
    window = await app.firstWindow()
    await expect(window.getByTestId("quick-editor").locator(".cm-md-heading-1")).toHaveCount(1)
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

/** Exercise Python save, run, and stop in both development and packaged Electron. */
async function checkQuickPythonRun(packaged: boolean): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-quick-python-"))
  const filePath = join(dataDir, "script.py")
  const venvBin = join(dataDir, ".venv", "bin")
  await mkdir(venvBin, { recursive: true })
  await writeFile(filePath, "print('before')\n")
  await writeFile(
    join(venvBin, "python3"),
    `#!/bin/sh
if [ "\${1-}" = "-c" ]; then
  printf '{"executable":"%s","version":"3.13"}\\n' "$0"
  exit 0
fi
if grep -q 'LONG_RUN' "$1"; then
  trap 'printf stopped > "$PWD/python-stopped"; exit 0' HUP INT TERM
  printf 'LONG_RUN_STARTED\\n'
  while :; do sleep 1; done
fi
if grep -q 'edited in Quick Editor' "$1"; then
  printf 'QUICK-PYTHON-SAVED-AND-RAN\\n'
else
  printf 'QUICK-PYTHON-OLD-FILE\\n'
fi
printf 'WORKING-DIR:%s\\n' "$PWD"
`,
    { mode: 0o755 },
  )
  const env = {
    ...process.env,
    PI_LAB_TEST_MODE: "1",
    PI_LAB_DATA_DIR: join(dataDir, "app-data"),
    PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
  }
  const launch = () =>
    electron.launch({
      executablePath: packaged ? packagedBinary : electronPath,
      args: packaged ? [filePath] : [mainEntry, filePath],
      env,
    })
  let app: ElectronApplication | null = null
  try {
    app = await launch()
    let window = await app.firstWindow()
    await expect(window.getByTestId("quick-editor").locator(".cm-content")).toContainText(
      "before",
      { timeout: 30_000 },
    )
    await expect(window.getByTestId("quick-python-run")).toHaveCount(0)
    const footer = window.getByTestId("quick-editor-status-bar")
    const pythonButton = footer
      .getByTestId("quick-editor-language")
      .getByRole("button", { name: /Python/ })
    await expect(pythonButton).toBeVisible({ timeout: 5_000 })
    await window.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="quick-python-environment"]')?.click()
    })
    const environmentMenu = window.getByRole("menu", { name: "Python environments" })
    await expect(environmentMenu).toContainText("Active interpreter")
    await expect(environmentMenu).toContainText("3.13")
    await expect(environmentMenu).toContainText(join(venvBin, "python3"))
    await window.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="quick-python-environment"]')?.click()
    })
    await window.getByRole("button", { name: "Open PI Lab" }).click()
    await window.getByTestId("nav-settings").click()
    await window.getByTestId("settings-nav-quick-editor").click()
    const setting = window.getByTestId("settings-quick-editor-run-python")
    await expect(setting).toHaveAttribute("data-checked", "false")
    await setting.click()
    await app.close()

    app = await launch()
    window = await app.firstWindow()
    const quick = window.getByTestId("quick-editor")
    const editor = quick.locator(".cm-content")
    await expect(editor).toContainText("before", { timeout: 30_000 })
    await expect(window.getByTestId("quick-python-run")).toBeVisible()
    await window.getByTestId("quick-python-environment").click()
    await expect(window.getByRole("menuitem", { name: /\.venv/ })).toBeVisible()
    await window.getByRole("menuitem", { name: /\.venv/ }).click()
    await editor.press("ControlOrMeta+End")
    await window.keyboard.type("# edited in Quick Editor")
    await editor.press("ControlOrMeta+Shift+Enter")
    await expect(window.getByTestId("quick-python-terminal")).toContainText(
      "QUICK-PYTHON-SAVED-AND-RAN",
      { timeout: 30_000 },
    )
    await expect(window.getByTestId("quick-python-terminal")).toContainText(
      `WORKING-DIR:${await realpath(dataDir)}`,
    )
    expect(await readFile(filePath, "utf8")).toContain("# edited in Quick Editor")
    await window.getByTestId("quick-python-terminal-close").click()
    await expect(window.getByTestId("quick-python-terminal")).toHaveCount(0)
    await writeFile(filePath, "print('LONG_RUN')\n")
    await expect(editor).toContainText("LONG_RUN", { timeout: 10_000 })
    await window.getByTestId("quick-python-run").click()
    await expect(window.getByTestId("quick-python-terminal")).toContainText("LONG_RUN_STARTED")
    await window.getByTestId("quick-python-terminal-close").click()
    await expect
      .poll(() =>
        existsSync(join(dataDir, "python-stopped"))
          ? readFile(join(dataDir, "python-stopped"), "utf8")
          : "",
      )
      .toBe("stopped")
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}

test("Quick Editor runs a saved Python file outside projects in an embedded terminal", async () => {
  test.skip(process.platform === "win32", "The test interpreter is a POSIX shell script")
  test.setTimeout(120_000)
  await checkQuickPythonRun(false)
})

test("packaged Quick Editor runs and stops Python", async () => {
  test.skip(process.platform === "win32", "The test interpreter is a POSIX shell script")
  test.skip(!existsSync(packagedBinary), "Packaged app is unavailable")
  test.setTimeout(120_000)
  await checkQuickPythonRun(true)
})

/** Verify a GUI launch follows the terminal's Python alias for display and Run. */
async function checkTerminalPythonFallback(packaged: boolean): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-quick-terminal-python-"))
  const filePath = join(dataDir, "script.py")
  const guiBin = join(dataDir, "gui-bin")
  const shellDir = join(dataDir, "shell")
  const terminalPython = join(dataDir, "python315")
  const installedPython = join(guiBin, "python3.13")
  const unrelatedVenv = join(dataDir, "other-project", ".venv")
  await mkdir(guiBin)
  await mkdir(shellDir)
  await mkdir(join(unrelatedVenv, "bin"), { recursive: true })
  await writeFile(filePath, "print('version')\n")
  await writeFile(
    join(guiBin, "python3"),
    `#!/bin/sh\nif [ "\${1-}" = "-c" ]; then printf '{"executable":"/usr/bin/python3","version":"3.9"}\\n'; exit 0; fi\nprintf 'WRONG-PYTHON-3.9\\n'\n`,
    { mode: 0o755 },
  )
  await writeFile(
    terminalPython,
    `#!/bin/sh
if [ "\${1-}" = "-c" ]; then
  printf '{"executable":"%s","version":"3.15"}\\n' "$0"
  exit 0
fi
printf 'TERMINAL-PYTHON-3.15:%s\\n' "$0"
`,
    { mode: 0o755 },
  )
  await writeFile(
    installedPython,
    `#!/bin/sh
if [ "\${1-}" = "-c" ]; then
  printf '{"executable":"%s","version":"3.13","isVenv":false,"isConda":false}\\n' "$0"
  exit 0
fi
printf 'INSTALLED-PYTHON-3.13:%s\\n' "$0"
`,
    { mode: 0o755 },
  )
  await writeFile(
    join(unrelatedVenv, "bin", "python3"),
    `#!/bin/sh\nprintf '{"executable":"%s","version":"3.12","isVenv":true}\\n' "$0"\n`,
    { mode: 0o755 },
  )
  await writeFile(
    join(shellDir, ".zshrc"),
    `printf '\\033]1337;ShellIntegrationVersion=14\\007'\nalias python='${terminalPython}'\n`,
  )
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: packaged ? packagedBinary : electronPath,
      args: packaged ? [filePath] : [mainEntry, filePath],
      env: {
        ...process.env,
        PATH: `${guiBin}:/usr/bin:/bin`,
        SHELL: "/bin/zsh",
        ZDOTDIR: shellDir,
        VIRTUAL_ENV: unrelatedVenv,
        UV_PROJECT_ENVIRONMENT: unrelatedVenv,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: join(dataDir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      },
    })
    const window = await app.firstWindow()
    await expect(window.getByTestId("quick-editor").locator(".cm-content")).toContainText(
      "version",
      { timeout: 30_000 },
    )
    await expect(window.getByTestId("quick-python-run")).toHaveCount(0)
    await window.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="quick-python-environment"]')?.click()
    })
    const menu = window.getByRole("menu", { name: "Python environments" })
    await expect(menu).toContainText("Python 3.15")
    await expect(menu).toContainText(terminalPython)
    await expect(menu).toContainText("Python 3.13")
    await expect(menu).toContainText(installedPython)
    await expect(menu).not.toContainText("other-project")
    await window.evaluate(() => localStorage.setItem("pi-lab.quickEditor.runPython", "true"))
    await window.reload()
    await window.getByTestId("quick-python-run").click()
    await expect(window.getByTestId("quick-python-terminal")).toContainText(
      `TERMINAL-PYTHON-3.15:${terminalPython}`,
      { timeout: 30_000 },
    )
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}

test("Quick Editor follows terminal Python without a virtual environment", async () => {
  test.skip(process.platform !== "darwin", "The shell alias fixture uses macOS zsh")
  test.setTimeout(90_000)
  await checkTerminalPythonFallback(false)
})

test("packaged Quick Editor follows terminal Python without a virtual environment", async () => {
  test.skip(process.platform !== "darwin", "The shell alias fixture uses macOS zsh")
  test.skip(!existsSync(packagedBinary), "Packaged app is unavailable")
  test.setTimeout(90_000)
  await checkTerminalPythonFallback(true)
})

test("Quick Editor uses a registered project's Python environment for a nested file", async () => {
  test.skip(process.platform === "win32", "The test interpreter is a POSIX shell script")
  test.setTimeout(90_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-quick-project-python-"))
  const projectDir = join(dataDir, "project")
  const filePath = join(projectDir, "src", "nested", "script.py")
  const interpreter = join(projectDir, ".venv", "bin", "python3")
  const appDataDir = join(dataDir, "app-data")
  await mkdir(dirname(filePath), { recursive: true })
  await mkdir(dirname(interpreter), { recursive: true })
  await writeFile(filePath, "print('project')\n")
  await writeFile(
    interpreter,
    `#!/bin/sh
if [ "\${1-}" = "-c" ]; then
  printf '{"executable":"%s","version":"3.13","isVenv":true}\\n' "$0"
  exit 0
fi
printf 'PROJECT-PYTHON:%s\\n' "$0"
`,
    { mode: 0o755 },
  )
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry, filePath],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: appDataDir,
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      },
    })
    const window = await app.firstWindow()
    await expect(window.getByTestId("quick-editor").locator(".cm-content")).toContainText(
      "project",
      { timeout: 30_000 },
    )
    await window.getByTestId("quick-python-environment").click()
    const menu = window.getByRole("menu", { name: "Python environments" })
    await expect(menu).toContainText("Active interpreter")
    await window.getByTestId("quick-python-environment").click()
    const canonicalProject = await realpath(projectDir)
    const escapedProject = canonicalProject.replaceAll("'", "''")
    const now = Date.now()
    execFileSync("/usr/bin/sqlite3", [
      join(appDataDir, "local.db"),
      `INSERT INTO projects (id, repo_path, name, created_at, updated_at, last_opened_at) VALUES ('quick-project', '${escapedProject}', 'Quick project', ${now}, ${now}, ${now})`,
    ])
    await window.getByTestId("quick-python-environment").click()
    await expect(menu.getByTestId("quick-python-active-version")).toContainText("Python 3.13")
    await expect(menu.getByTestId("quick-python-active-path")).toContainText(interpreter)
    await window.evaluate(() => localStorage.setItem("pi-lab.quickEditor.runPython", "true"))
    await window.reload()
    await window.getByTestId("quick-python-run").click()
    await expect(window.getByTestId("quick-python-terminal")).toContainText(
      `PROJECT-PYTHON:${await realpath(interpreter)}`,
      { timeout: 30_000 },
    )
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

/** Exercise the file launch through the real Electron entry and renderer. */
test("quick edit opens a local file before the full app, saves it, and keeps it open", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-quick-edit-"))
  const filePath = join(dataDir, "scratch.py")
  await writeFile(filePath, "value = 1\n")
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry, filePath],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: join(dataDir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      },
    })
    const window = await app.firstWindow()
    const editor = window.getByTestId("quick-editor").locator(".cm-content")
    await expect(editor).toContainText("value = 1", { timeout: 30_000 })
    await expect(editor).toBeFocused()
    await expect
      .poll(() =>
        window.evaluate(() => {
          const editor = document.querySelector(".cm-editor")
          const surface = document.querySelector('[data-testid="quick-editor"]')
          if (!editor || !surface) return false
          return (
            getComputedStyle(editor).backgroundColor === getComputedStyle(surface).backgroundColor
          )
        }),
      )
      .toBe(true)
    await editor.press("ControlOrMeta+End")
    await window.keyboard.type("value = 2\n")
    await editor.press("ControlOrMeta+s")
    await expect.poll(() => readFile(filePath, "utf8")).toContain("value = 2")

    await window.evaluate(() => {
      localStorage.setItem("pi-lab.theme", "dark")
      window.location.reload()
    })
    await expect(window.getByTestId("quick-editor").locator(".cm-content")).toContainText(
      "value = 2",
    )
    await expect
      .poll(() =>
        window.evaluate(() => {
          const editor = document.querySelector(".cm-editor")
          const surface = document.querySelector('[data-testid="quick-editor"]')
          if (!editor || !surface) return false
          return (
            document.documentElement.classList.contains("dark") &&
            getComputedStyle(editor).backgroundColor === getComputedStyle(surface).backgroundColor
          )
        }),
      )
      .toBe(true)

    await window.getByRole("button", { name: "Open PI Lab" }).click()
    await expect(window.getByTestId("quick-editor-full-app")).toBeVisible({ timeout: 30_000 })
    await expect(window.getByTestId("quick-editor-full-app")).toContainText("value = 2")
    expect(
      await window.evaluate(() => {
        const editor = document.querySelector(".cm-editor")
        const surface = document.querySelector('[data-testid="quick-editor-full-app"]')
        if (!editor || !surface) return false
        return (
          getComputedStyle(editor).backgroundColor === getComputedStyle(surface).backgroundColor
        )
      }),
    ).toBe(true)
    await expect(window.getByTestId("nav-editor")).toHaveAttribute("data-active", "true")
    await expect(
      window.getByTestId("quick-editor-full-app").getByRole("button", { name: "Open PI Lab" }),
    ).toHaveCount(0)
    await window.getByTestId("nav-dashboard").click()
    await expect(window.getByTestId("nav-editor")).toHaveAttribute("data-active", "false")
    await window.getByTestId("nav-editor").click()
    await expect(window.getByTestId("quick-editor-full-app")).toContainText("value = 2")
    expect(await app.windows()).toHaveLength(1)
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("quick editor keeps its header visible and opens PI Lab with Command Enter", async () => {
  test.setTimeout(120_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-quick-header-"))
  const filePath = join(dataDir, "long.py")
  await writeFile(
    filePath,
    Array.from({ length: 300 }, (_, index) => `value_${index} = ${index}\n`).join(""),
  )
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry, filePath],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: join(dataDir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      },
    })
    const window = await app.firstWindow()
    const quick = window.getByTestId("quick-editor")
    const editor = quick.locator(".cm-content")
    await expect(editor).toContainText("value_0", { timeout: 30_000 })
    const heading = quick.getByRole("heading", { name: "PI Lab Editor" })
    const path = quick.getByTestId("quick-editor-path")
    await expect(heading).toBeVisible()
    await expect(path).toHaveText(filePath)
    const firstTop = await heading.evaluate((element) => element.getBoundingClientRect().top)
    const titleRight = await heading.evaluate((element) => element.getBoundingClientRect().right)
    const pathLeft = await path.evaluate((element) => element.getBoundingClientRect().left)
    expect(pathLeft - titleRight).toBeGreaterThanOrEqual(12)
    const scroller = quick.locator(".cm-scroller")
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    expect(await heading.evaluate((element) => element.getBoundingClientRect().top)).toBe(firstTop)
    expect(await window.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0)
    await expect(quick.getByRole("button", { name: "Save" })).toBeVisible()
    await expect(quick.getByRole("button", { name: "Open PI Lab" })).toBeVisible()
    await editor.press("ControlOrMeta+End")
    await window.keyboard.type("after_scroll = True\n")
    await editor.press("ControlOrMeta+s")
    await expect.poll(() => readFile(filePath, "utf8")).toContain("after_scroll = True")
    await editor.press("ControlOrMeta+Enter")
    await expect(window.getByTestId("quick-editor-full-app")).toBeVisible({ timeout: 30_000 })
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("Editor leads the sidebar and opens an Untitled tab or chosen file", async () => {
  test.setTimeout(120_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-editor-nav-"))
  const firstFile = join(dataDir, "first.py")
  const chosenFile = join(dataDir, "chosen.py")
  await writeFile(firstFile, "first = True\n")
  await writeFile(chosenFile, "chosen = True\n")
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry, firstFile],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: join(dataDir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
        PI_LAB_TEST_PICK_FILE: chosenFile,
      },
    })
    const window = await app.firstWindow()
    await expect(window.getByTestId("quick-editor").locator(".cm-content")).toContainText(
      "first = True",
      { timeout: 30_000 },
    )
    await window.getByRole("button", { name: "Open PI Lab" }).click()
    await expect(window.getByTestId("quick-editor-tab")).toContainText("first.py", {
      timeout: 30_000,
    })
    await window.getByTestId("quick-editor-tab-close").click()
    await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })
    const nav = window.getByTestId("science-nav")
    const editorNav = nav.getByTestId("nav-editor")
    await expect(editorNav).toBeVisible()
    expect(
      await editorNav.evaluate((element) => element.nextElementSibling?.textContent),
    ).toContain("Analysis")
    await editorNav.click()
    await expect(window.getByTestId("quick-editor-tab")).toContainText("Untitled")
    await expect(window.getByTestId("quick-editor-full-app").locator(".cm-content")).toBeVisible()

    await window.getByTestId("nav-dashboard").click()
    await window.keyboard.press("ControlOrMeta+p")
    await window.getByTestId("command-palette-input").fill("Go to Editor")
    await window.locator('[data-command-id="nav-editor"]').click()
    await expect(window.getByTestId("quick-editor-tab")).toContainText("Untitled")
    const untitledEditor = window.getByTestId("quick-editor-full-app").locator(".cm-content")
    await untitledEditor.fill("Keep this draft")
    await window.getByRole("button", { name: "Open File" }).click()
    const replace = window.getByRole("dialog", { name: "Open file over Untitled" })
    await expect(replace).toBeVisible()
    await replace.getByRole("button", { name: "Cancel" }).click()
    await expect(untitledEditor).toContainText("Keep this draft")
    await window.getByRole("button", { name: "Open File" }).click()
    await replace.getByRole("button", { name: "Discard" }).click()
    await expect(window.getByTestId("quick-editor-tab")).toContainText("chosen.py", {
      timeout: 30_000,
    })
    await expect(window.getByTestId("quick-editor-full-app").locator(".cm-content")).toContainText(
      "chosen = True",
    )
    await expect(
      window.getByTestId("quick-editor-full-app").getByRole("button", { name: "Save" }),
    ).toBeDisabled()
    await window.getByTestId("quick-editor-tab-close").click()
    await expect(window.getByTestId("dashboard")).toBeVisible()
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("Untitled asks before closing and saves to a chosen path", async () => {
  test.setTimeout(120_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-untitled-path-"))
  const savedPath = join(dataDir, "saved.py")
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: join(dataDir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
        PI_LAB_TEST_SAVE_FILE_PATH: savedPath,
      },
    })
    const window = await app.firstWindow()
    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await window.getByTestId("nav-editor").click()
    const editor = window.getByTestId("quick-editor-full-app").locator(".cm-content")
    await expect(window.getByTestId("quick-editor-tab")).toContainText("Untitled")
    await editor.fill("answer = 42\n")
    await window.getByTestId("quick-editor-tab-close").click()
    const close = window.getByRole("dialog", { name: "Close editor file" })
    await expect(close).toBeVisible()
    await close.getByRole("button", { name: "Cancel" }).click()
    await expect(editor).toContainText("answer = 42")
    await editor.press("ControlOrMeta+s")
    const save = window.getByRole("dialog", { name: "Save Untitled" })
    await expect(save).toBeVisible()
    await save.getByRole("button", { name: "Save to any path" }).click()
    await expect.poll(() => readFile(savedPath, "utf8")).toBe("answer = 42\n")
    await expect(window.getByTestId("quick-editor-tab")).toContainText("saved.py")
    await expect(
      window.getByTestId("quick-editor-full-app").getByRole("button", { name: "Save" }),
    ).toBeDisabled()
    await window.getByTestId("quick-editor-tab-close").click()
    await expect(window.getByTestId("dashboard")).toBeVisible()
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("Untitled saves inside a project and opens there", async () => {
  test.setTimeout(120_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-untitled-project-"))
  const projectDir = join(dataDir, "project")
  await mkdir(projectDir)
  await mkdir(join(projectDir, "notes"))
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: join(dataDir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
        PI_LAB_TEST_OPEN_PROJECT: projectDir,
      },
    })
    const window = await app.firstWindow()
    await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })
    await window.getByTestId("nav-editor").click()
    const editor = window.getByTestId("quick-editor-full-app").locator(".cm-content")
    await editor.fill("value = 7\n")
    await window.getByTestId("quick-editor-full-app").getByRole("button", { name: "Save" }).click()
    const save = window.getByRole("dialog", { name: "Save Untitled" })
    await save.getByRole("button", { name: "Save in project" }).click()
    const projectSave = window.getByTestId("new-file-dialog")
    await expect(projectSave).toBeVisible()
    await projectSave.getByLabel("Project").selectOption({ index: 1 })
    await projectSave.getByLabel("File name").fill("notes/saved.py")
    await projectSave.getByRole("button", { name: "Create and open" }).click()
    await expect
      .poll(() => readFile(join(projectDir, "notes", "saved.py"), "utf8"))
      .toBe("value = 7\n")
    await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
    await expect(window.getByTestId("central-tab").filter({ hasText: "saved.py" })).toBeVisible()
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("quitting with a dirty Untitled file asks before closing", async () => {
  test.setTimeout(60_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-untitled-quit-"))
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: join(dataDir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      },
    })
    const window = await app.firstWindow()
    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await window.getByTestId("nav-editor").click()
    await window.getByTestId("quick-editor-full-app").locator(".cm-content").fill("not saved\n")
    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    const prompt = window.getByRole("dialog", { name: "Unsaved quick edit" })
    await expect(prompt).toBeVisible()
    await prompt.getByRole("button", { name: "Cancel" }).click()
    await expect(window.getByTestId("quick-editor-tab")).toContainText("Untitled")
    await window.getByTestId("quick-editor-tab-close").click()
    await window
      .getByRole("dialog", { name: "Close editor file" })
      .getByRole("button", { name: "Discard" })
      .click()
    await expect(window.getByTestId("dashboard")).toBeVisible()
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("a hidden Untitled draft can be saved during quit", async () => {
  test.setTimeout(60_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-hidden-untitled-"))
  const savedPath = join(dataDir, "recovered.py")
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: join(dataDir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
        PI_LAB_TEST_SAVE_FILE_PATH: savedPath,
      },
    })
    const window = await app.firstWindow()
    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await window.getByTestId("nav-editor").click()
    await window.getByTestId("quick-editor-full-app").locator(".cm-content").fill("kept = True\n")
    await window.getByTestId("nav-dashboard").click()
    await expect(window.getByTestId("dashboard")).toBeVisible()
    await app.evaluate(({ app: electronApp }) => electronApp.quit())
    const recovery = window.getByRole("dialog", { name: "Unsaved changes" })
    await expect(recovery).toBeVisible()
    await recovery.getByRole("button", { name: "Save affected" }).click()
    const destination = window.getByRole("dialog", { name: "Save Untitled" })
    await expect(destination).toBeVisible()
    await destination.getByRole("button", { name: "Save to any path" }).click()
    await expect.poll(() => readFile(savedPath, "utf8")).toBe("kept = True\n")
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("full-app Editor has one closable file tab and protects unsaved edits", async () => {
  test.setTimeout(120_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-editor-tab-"))
  const filePath = join(dataDir, "scratch.py")
  await writeFile(filePath, "value = 1\n")
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry, filePath],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: join(dataDir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      },
    })
    const window = await app.firstWindow()
    await expect(window.getByTestId("quick-editor").locator(".cm-content")).toContainText(
      "value = 1",
      { timeout: 30_000 },
    )
    await window.getByRole("button", { name: "Open PI Lab" }).click()
    await expect(window.getByRole("heading", { name: "Editor" })).toBeVisible({ timeout: 30_000 })
    await expect(window.getByTestId("quick-editor-header-filename")).toHaveText("scratch.py")
    await expect(window.getByTestId("quick-editor-tab")).toHaveCount(1)
    await expect(window.getByTestId("quick-editor-tab")).toContainText("scratch.py")

    const editor = window.getByTestId("quick-editor-full-app").locator(".cm-content")
    await editor.press("ControlOrMeta+End")
    await window.keyboard.type("value = 2\n")
    await window.getByTestId("quick-editor-tab-close").click()
    const closeDialog = window.getByRole("dialog", { name: "Close editor file" })
    await expect(closeDialog).toBeVisible()
    await closeDialog.getByRole("button", { name: "Cancel" }).click()
    await expect(window.getByTestId("quick-editor-tab")).toBeVisible()
    expect(await readFile(filePath, "utf8")).toBe("value = 1\n")

    await writeFile(filePath, "external = 1\n")
    await window.getByTestId("quick-editor-tab-close").click()
    await closeDialog.getByRole("button", { name: "Save" }).click()
    await expect(closeDialog).toHaveCount(0)
    await expect(window.getByRole("alert")).toContainText("changed on disk")
    await window.getByRole("button", { name: "Overwrite disk" }).click()
    await expect.poll(() => readFile(filePath, "utf8")).toContain("value = 2")

    await editor.press("ControlOrMeta+End")
    await window.keyboard.type("value = 4\n")
    await window.getByTestId("quick-editor-tab-close").click()
    await expect(closeDialog).toBeVisible()
    await closeDialog.getByRole("button", { name: "Save" }).click()
    await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })
    await expect(window.getByTestId("nav-editor")).toHaveAttribute("data-active", "false")
    await expect.poll(() => readFile(filePath, "utf8")).toContain("value = 4")
    expect(await app.windows()).toHaveLength(1)

    await app.evaluate(
      ({ app }, path) => app.emit("open-file", { preventDefault() {} }, path),
      filePath,
    )
    const reopened = window.getByTestId("quick-editor-full-app").locator(".cm-content")
    await expect(reopened).toContainText("value = 4", { timeout: 30_000 })
    await reopened.press("ControlOrMeta+End")
    await window.keyboard.type("value = 3\n")
    await window.getByTestId("quick-editor-tab-close").click()
    await closeDialog.getByRole("button", { name: "Discard" }).click()
    await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })
    await expect(window.getByTestId("nav-editor")).toHaveAttribute("data-active", "false")
    expect(await readFile(filePath, "utf8")).not.toContain("value = 3")
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("a registered project file enters its normal project editor", async () => {
  test.setTimeout(60_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-quick-project-"))
  const projectDir = join(dataDir, "project")
  const filePath = join(projectDir, "main.cpp")
  await mkdir(projectDir)
  await writeFile(filePath, "int main() { return 0; }\n")
  const env = {
    ...process.env,
    PI_LAB_TEST_MODE: "1",
    PI_LAB_DATA_DIR: join(dataDir, "app-data"),
    PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
  }
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry],
      env: { ...env, PI_LAB_TEST_OPEN_PROJECT: projectDir },
    })
    const firstWindow = await app.firstWindow()
    await expect(firstWindow.getByTestId("project-item")).toContainText("project", {
      timeout: 30_000,
    })
    await app.close()

    app = await electron.launch({ executablePath: electronPath, args: [mainEntry, filePath], env })
    const window = await app.firstWindow()
    await expect(window.getByTestId("quick-editor").locator(".cm-content")).toContainText(
      "int main()",
      { timeout: 30_000 },
    )
    await window.getByRole("button", { name: "Open PI Lab" }).click()
    await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
    await expect(window.getByTestId("editor-buffer")).toContainText("int main()", {
      timeout: 30_000,
    })
    expect(await app.windows()).toHaveLength(1)
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("quick edit uses the appearance saved in the full app", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-quick-appearance-"))
  const filePath = join(dataDir, "scratch.py")
  await writeFile(filePath, "value = 3\n")
  const env = {
    ...process.env,
    PI_LAB_TEST_MODE: "1",
    PI_LAB_DATA_DIR: join(dataDir, "app-data"),
    PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
  }
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({ executablePath: electronPath, args: [mainEntry], env })
    const fullWindow = await app.firstWindow()
    await expect(fullWindow.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await fullWindow.evaluate(() => {
      localStorage.setItem("pi-lab.theme", "dark")
      localStorage.setItem("pi-lab.appTheme", "tokyo-night")
      window.location.reload()
    })
    await expect(fullWindow.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    const fullBackground = await fullWindow.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--background"),
    )
    await app.close()

    app = await electron.launch({ executablePath: electronPath, args: [mainEntry, filePath], env })
    const quickWindow = await app.firstWindow()
    await expect(quickWindow.getByTestId("quick-editor").locator(".cm-content")).toContainText(
      "value = 3",
      { timeout: 30_000 },
    )
    await expect
      .poll(() => quickWindow.evaluate(() => document.documentElement.classList.contains("dark")))
      .toBe(true)
    expect(
      await quickWindow.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--background"),
      ),
    ).toBe(fullBackground)
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("a file opened while PI Lab is running can enter its project", async () => {
  test.setTimeout(60_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-quick-warm-"))
  const projectDir = join(dataDir, "project")
  const filePath = join(projectDir, "main.cpp")
  await mkdir(projectDir)
  await writeFile(filePath, "int answer = 42;\n")
  const env = {
    ...process.env,
    PI_LAB_TEST_MODE: "1",
    PI_LAB_DATA_DIR: join(dataDir, "app-data"),
    PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
  }
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry],
      env: { ...env, PI_LAB_TEST_OPEN_PROJECT: projectDir },
    })
    const firstWindow = await app.firstWindow()
    await expect(firstWindow.getByTestId("project-item")).toContainText("project", {
      timeout: 30_000,
    })
    await app.close()

    app = await electron.launch({ executablePath: electronPath, args: [mainEntry], env })
    const window = await app.firstWindow()
    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await app.evaluate(({ app }, path) => {
      app.emit("open-file", { preventDefault() {} }, path)
    }, filePath)
    await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
    await expect(window.getByTestId("editor-buffer")).toContainText("int answer", {
      timeout: 30_000,
    })
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("a project file opened from an unsaved full-app quick edit saves the draft", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-quick-dirty-route-"))
  const projectDir = join(dataDir, "project")
  const projectFile = join(projectDir, "main.cpp")
  const outsideFile = join(dataDir, "draft.py")
  await mkdir(projectDir)
  await writeFile(projectFile, "int answer = 42;\n")
  await writeFile(outsideFile, "value = 1\n")
  const env = {
    ...process.env,
    PI_LAB_TEST_MODE: "1",
    PI_LAB_DATA_DIR: join(dataDir, "app-data"),
    PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
  }
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry],
      env: { ...env, PI_LAB_TEST_OPEN_PROJECT: projectDir },
    })
    const firstWindow = await app.firstWindow()
    await expect(firstWindow.getByTestId("project-item")).toContainText("project", {
      timeout: 30_000,
    })
    await app.close()

    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry, outsideFile],
      env,
    })
    const window = await app.firstWindow()
    await expect(window.getByTestId("quick-editor").locator(".cm-content")).toContainText(
      "value = 1",
      { timeout: 30_000 },
    )
    await window.getByRole("button", { name: "Open PI Lab" }).click()
    const editor = window.getByTestId("quick-editor-full-app").locator(".cm-content")
    await expect(editor).toContainText("value = 1", { timeout: 30_000 })
    await editor.press("ControlOrMeta+End")
    await window.keyboard.type("value = 2\n")
    await app.evaluate(
      ({ app }, path) => app.emit("open-file", { preventDefault() {} }, path),
      projectFile,
    )
    await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
    await expect(window.getByTestId("editor-buffer")).toContainText("int answer", {
      timeout: 30_000,
    })
    await expect.poll(() => readFile(outsideFile, "utf8")).toContain("value = 2")
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("a project file opened during full-app startup reaches its project", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-quick-startup-route-"))
  const projectDir = join(dataDir, "project")
  const filePath = join(projectDir, "main.cpp")
  await mkdir(projectDir)
  await writeFile(filePath, "int answer = 42;\n")
  const env = {
    ...process.env,
    PI_LAB_TEST_MODE: "1",
    PI_LAB_DATA_DIR: join(dataDir, "app-data"),
    PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
  }
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry],
      env: { ...env, PI_LAB_TEST_OPEN_PROJECT: projectDir },
    })
    const firstWindow = await app.firstWindow()
    await expect(firstWindow.getByTestId("project-item")).toContainText("project", {
      timeout: 30_000,
    })
    await app.close()

    app = await electron.launch({ executablePath: electronPath, args: [mainEntry], env })
    const window = await app.firstWindow()
    await app.evaluate(
      ({ app }, path) => app.emit("open-file", { preventDefault() {} }, path),
      filePath,
    )
    await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
    await expect(window.getByTestId("editor-buffer")).toContainText("int answer", {
      timeout: 30_000,
    })
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("first-run setup returns to the selected file", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-quick-first-run-"))
  const filePath = join(dataDir, "scratch.py")
  await writeFile(filePath, "value = 7\n")
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry, filePath],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_TEST_FIRST_RUN: "1",
        PI_LAB_DATA_DIR: join(dataDir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      },
    })
    const window = await app.firstWindow()
    await expect(window.getByTestId("quick-editor").locator(".cm-content")).toContainText(
      "value = 7",
      { timeout: 30_000 },
    )
    await window.getByRole("button", { name: "Open PI Lab" }).click()
    await expect(window.getByRole("button", { name: "Skip setup" }).first()).toBeVisible({
      timeout: 30_000,
    })
    await window.getByRole("button", { name: "Skip setup" }).first().click()
    await expect(window.getByTestId("quick-editor-full-app")).toContainText("value = 7", {
      timeout: 30_000,
    })
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
