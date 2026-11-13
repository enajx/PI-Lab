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

/** Open a group row (the folders above the experiment level). */
export async function openAnalysisGroup(window: Page, group: string): Promise<void> {
  const row = window.locator(`[data-testid="analysis-group"][data-group="${group}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click()
  await expect(row).toHaveAttribute("aria-expanded", "true")
}

/** Open a folder row inside an experiment (`folder` is its path inside the row). */
export async function openAnalysisFolder(window: Page, folder: string): Promise<void> {
  const row = window.locator(`[data-testid="analysis-folder"][data-folder="${folder}"]`).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click()
  await expect(row).toHaveAttribute("aria-expanded", "true")
}
