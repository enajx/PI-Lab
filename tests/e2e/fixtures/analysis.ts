import { expect, type Page } from "./playwright"

/**
 * Open a run row in the Analysis file list (the auto-detected structure lists a
 * run's files only after its row is opened). Does nothing when it is open.
 */
export async function openAnalysisRun(window: Page, run: string): Promise<void> {
  const row = window.locator(`[data-testid="analysis-run"][data-run="${run}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click()
  await expect(row).toHaveAttribute("aria-expanded", "true")
}
