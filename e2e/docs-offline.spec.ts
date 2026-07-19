import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, test } from "@playwright/test"

const DOCS_ROOT = join(import.meta.dirname, "..", "docs")
const DOCS_ENTRY = join(DOCS_ROOT, "index.html")
const DOCS_ENTRY_URL = pathToFileURL(DOCS_ENTRY).href
const VISION_URL = pathToFileURL(join(DOCS_ROOT, "01-vision-and-pitch.html")).href
const ARCHITECTURE_URL = pathToFileURL(join(DOCS_ROOT, "engineering", "architecture.html")).href

test.skip(!existsSync(DOCS_ENTRY), "offline documentation not built; run bun run docs:build")

test("generated documentation works directly from file:// without a server", async ({ page }) => {
  const failedLocalRequests: string[] = []
  page.on("requestfailed", (request) => {
    if (request.url().startsWith("file:")) failedLocalRequests.push(request.url())
  })

  await page.goto(DOCS_ENTRY_URL)
  expect(new URL(page.url()).protocol).toBe("file:")
  await expect(page.locator("h1").first()).toContainText("PI Lab")
  await expect
    .poll(() => page.locator(".VPNav").evaluate((element) => getComputedStyle(element).position))
    .toBe("fixed")

  await page
    .locator(".VPSidebar")
    .getByRole("link", { name: "Vision and pitch", exact: true })
    .click()
  await expect(page).toHaveURL(VISION_URL)
  await expect(page.locator("h1").first()).toContainText("Vision, pitch")

  const image = page.locator("main img").first()
  await image.scrollIntoViewIfNeeded()
  await expect.poll(() => image.evaluate((element) => element.naturalWidth)).toBeGreaterThan(0)

  await page.locator(".VPSidebar").getByRole("link", { name: "Architecture", exact: true }).click()
  await expect(page).toHaveURL(ARCHITECTURE_URL)
  await expect(page.locator("h1").first()).toContainText("architecture")

  expect(failedLocalRequests).toEqual([])
})
