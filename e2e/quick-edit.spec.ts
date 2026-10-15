import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

const here = dirname(fileURLToPath(import.meta.url))
const desktop = join(here, "..", "apps", "desktop")
const mainEntry = join(desktop, "out", "main", "index.js")
const electronPath = createRequire(join(desktop, "package.json"))("electron") as string

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
    await editor.press("ControlOrMeta+w")
    await expect(closeDialog).toBeVisible()
    await closeDialog.getByRole("button", { name: "Save" }).click()
    await expect(window.getByTestId("dashboard")).toBeVisible({ timeout: 30_000 })
    await expect(window.getByTestId("nav-editor")).toHaveCount(0)
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
    await expect(window.getByTestId("nav-editor")).toHaveCount(0)
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
