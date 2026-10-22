import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { _electron as electron, expect, test } from "@playwright/test"

/** Real Electron IPC and filesystem reads, with no mocked reader. */
test("oversized and binary files stay out of the editor; rejected reload preserves text", async () => {
  test.setTimeout(60_000)
  const root = await mkdtemp(join(tmpdir(), "pi-lab-bounded-e2e-"))
  const repo = join(root, "project")
  const { mkdir } = await import("node:fs/promises")
  await mkdir(repo)
  await writeFile(join(repo, "large.txt"), "x".repeat(10_000_001))
  await writeFile(join(repo, "RESEARCH.md"), "x".repeat(10_000_001))
  await writeFile(join(repo, "binary.txt"), Buffer.from([0, 65]))
  await writeFile(join(repo, "small.txt"), "preserve this text")
  await writeFile(join(repo, "exact.txt"), `${"e".repeat(99)}\n`.repeat(100_000))
  const desktop = resolve("apps/desktop")
  const app = await electron.launch({
    executablePath: createRequire(join(desktop, "package.json"))("electron") as string,
    args: [join(desktop, "out/main/index.js")],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: root,
      PI_LAB_SOCKET_PATH: join(root, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: repo,
    },
  })
  const fixtureProcess = app.process()
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await page.getByTestId("project-item").click()
    await page.getByTestId("panel-tab-research").click()
    await expect(page.getByTestId("panel-research-rejected")).toContainText("10,000,001 bytes")
    await expect(page.getByRole("button", { name: "Reveal in Finder", exact: true })).toBeVisible()
    await page.getByTestId("panel-tab-files").click()
    await page.getByTestId("file-tree-file").filter({ hasText: "large.txt" }).click()
    await expect(page.getByTestId("editor-rejected-read")).toContainText("10,000,001 bytes")
    await expect(page.getByRole("button", { name: "Reveal in Finder", exact: true })).toBeVisible()
    await expect(page.getByTestId("editor-buffer")).toHaveCount(0)
    await page.getByTestId("file-tree-file").filter({ hasText: "binary.txt" }).click()
    await expect(page.getByTestId("editor-rejected-read")).toContainText("binary")
    await expect(page.getByTestId("editor-buffer")).toHaveCount(0)
    await page.getByTestId("file-tree-file").filter({ hasText: "small.txt" }).click()
    await expect(page.getByTestId("editor-buffer")).toContainText("preserve this text")
    await writeFile(join(repo, "small.txt"), "x".repeat(10_000_001))
    await expect(page.getByTestId("editor-rejected-read")).toContainText("10,000,001 bytes", {
      timeout: 10_000,
    })
    await expect(page.getByTestId("editor-buffer")).toContainText("preserve this text")
    await page.getByTestId("file-tree-file").filter({ hasText: "exact.txt" }).click()
    const editor = page.getByTestId("editor-buffer").locator(".cm-content")
    await expect(editor).toBeVisible()
    await editor.click()
    await page.keyboard.press("ControlOrMeta+End")
    await page.keyboard.insertText("SAVED-ABOVE-CAP")
    await page.keyboard.press("ControlOrMeta+s")
    await expect
      .poll(
        async () => (await readFile(join(repo, "exact.txt"), "utf8")).endsWith("SAVED-ABOVE-CAP"),
        { timeout: 15_000 },
      )
      .toBe(true)
  } finally {
    const forceExit = setTimeout(() => fixtureProcess.kill("SIGKILL"), 5_000)
    await app
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
      })
      .catch(() => undefined)
    await app.close().catch(() => fixtureProcess.kill("SIGKILL"))
    clearTimeout(forceExit)
    await rm(root, { recursive: true, force: true })
  }
})
