import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type { Page } from "@playwright/test"
import { _electron as electron, expect, test } from "./fixtures/playwright"

// Every enabled clickable element shows a visible hover change (agreed 2026-11-17).
// This walks the main screens and the setup wizard, hovers each visible clickable
// element, and lists the ones whose look did not change. Elements opt out of the
// default hover only with `data-no-hover`.

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

const CLICKABLE = 'button, a[href], [role="button"], select, summary'

/** Style properties a hover state can change; any difference counts as visible feedback. */
const WATCHED = [
  "background-color",
  "background-image",
  "color",
  "border-color",
  "box-shadow",
  "opacity",
  "text-decoration-line",
  "outline-color",
  "filter",
] as const

/**
 * Hover every visible, enabled, unobstructed clickable element on the current screen
 * and return a short description of each one whose watched styles did not change.
 */
async function elementsWithoutHover(page: Page): Promise<string[]> {
  // Tag the candidates once, so each can be found again after the mouse moves.
  const count = await page.evaluate((selector) => {
    let index = 0
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      element.removeAttribute("data-hover-audit")
      if (element.closest("[data-no-hover]")) continue
      if (
        (element as HTMLButtonElement).disabled ||
        element.getAttribute("aria-disabled") === "true"
      )
        continue
      const box = element.getBoundingClientRect()
      if (box.width < 4 || box.height < 4) continue
      if (box.bottom <= 0 || box.right <= 0) continue
      if (box.top >= window.innerHeight || box.left >= window.innerWidth) continue
      const x = box.left + box.width / 2
      const y = box.top + box.height / 2
      const hit = document.elementFromPoint(x, y)
      // Skip elements covered by something else; that element gets audited instead.
      if (!hit || !(element === hit || element.contains(hit))) continue
      element.setAttribute("data-hover-audit", String(index))
      index += 1
    }
    return index
  }, CLICKABLE)

  const missing: string[] = []
  for (let index = 0; index < count; index += 1) {
    const element = page.locator(`[data-hover-audit="${index}"]`)
    // Feedback counts on the element, its icons and labels, or the card or row
    // around it (up to three levels up), since many designs highlight the container.
    const read = () =>
      element.evaluate(
        (node, watched) => {
          const nodes: Element[] = [node, ...Array.from(node.querySelectorAll("*")).slice(0, 30)]
          let parent = node.parentElement
          for (let level = 0; parent && level < 3; level += 1) {
            nodes.push(parent)
            parent = parent.parentElement
          }
          return nodes
            .map((item) => {
              const style = getComputedStyle(item)
              return watched.map((name) => style.getPropertyValue(name)).join("|")
            })
            .join("||")
        },
        [...WATCHED],
      )
    await page.mouse.move(0, 0)
    await page.waitForTimeout(150)
    const box = await element.boundingBox()
    if (!box) continue
    const before = await read()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    // Wait up to 1 s for the hover style; transitions run at different speeds.
    let after = await read()
    for (let tries = 0; after === before && tries < 10; tries += 1) {
      await page.waitForTimeout(100)
      after = await read()
    }
    if (before === after) {
      missing.push(
        await element.evaluate((node) => {
          const testId = node.getAttribute("data-testid")
          const label =
            node.getAttribute("aria-label") ?? node.textContent?.trim().slice(0, 40) ?? ""
          return `${node.tagName.toLowerCase()}${testId ? `[data-testid=${testId}]` : ""} "${label}"`
        }),
      )
    }
  }
  await page.mouse.move(0, 0)
  return missing
}

async function makeRepo(root: string): Promise<string> {
  const repo = join(root, "repo")
  await execFileAsync("git", ["init", "-q", "-b", "main", repo])
  await writeFile(join(repo, "notes.md"), "# Hover fixture\n")
  await execFileAsync("git", ["-C", repo, "add", "."])
  await execFileAsync("git", [
    "-C",
    repo,
    "-c",
    "user.name=PI Lab Test",
    "-c",
    "user.email=test@pi-lab.local",
    "commit",
    "-qm",
    "fixture",
  ])
  return repo
}

test("every clickable element on the main screens shows a hover change", async () => {
  test.setTimeout(240_000)
  const root = await mkdtemp(join(tmpdir(), "pi-lab-e2e-hover-audit-"))
  const repo = await makeRepo(root)
  const dataDir = join(root, "data")
  const app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: repo,
    },
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    const report: Record<string, string[]> = {}

    report.dashboard = await elementsWithoutHover(page)

    // Elements with a designed hover keep it: no default overlay on top.
    for (const testId of ["nav-project-dashboard", "project-card-open"]) {
      const element = page.getByTestId(testId)
      await element.hover()
      await page.waitForTimeout(250)
      const overlay = await element.evaluate((node) =>
        getComputedStyle(node).getPropertyValue("--hover-overlay").trim(),
      )
      expect(overlay, `${testId} must keep its designed hover`).toMatch(
        /^(transparent|rgba\(0, 0, 0, 0\))$/,
      )
    }

    await page.getByTestId("project-item").click()
    await page.waitForTimeout(1000)
    report.project = await elementsWithoutHover(page)

    await page.getByTestId("nav-settings").click()
    for (const section of ["general", "appearance", "agents"]) {
      await page.getByTestId(`settings-nav-${section}`).click()
      await page.waitForTimeout(300)
      report[`settings/${section}`] = await elementsWithoutHover(page)
    }

    const failures = Object.entries(report).filter(([, missing]) => missing.length > 0)
    expect(failures, JSON.stringify(Object.fromEntries(failures), null, 2)).toEqual([])
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("every clickable element in the setup wizard shows a hover change", async () => {
  test.setTimeout(120_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-hover-audit-setup-"))
  const app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_TEST_FIRST_RUN: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
    },
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId("first-run-setup")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("Checking…")).toHaveCount(0, { timeout: 30_000 })
    const missing = await elementsWithoutHover(page)
    expect(missing, JSON.stringify(missing, null, 2)).toEqual([])
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
