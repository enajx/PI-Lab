import { expect, type Page } from "./playwright"

/**
 * Open an experiment row in the Analysis file list (rows are collapsed, and a
 * row lists its files only after it is opened). `experiment` is the row's
 * `data-experiment`: the experiment, else the run, of its files. Does nothing
 * when it is open.
 */
export async function openAnalysisExperiment(window: Page, experiment: string): Promise<void> {
  const row = window.locator(`[data-testid="analysis-experiment"][data-experiment="${experiment}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click()
  await expect(row).toHaveAttribute("aria-expanded", "true")
}
