import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stopLeftoverE2eProcesses } from "./leftoverProcesses"

/** Playwright globalSetup: stops processes left by a previous interrupted e2e run. */
export default async function globalSetup(): Promise<void> {
  await stopLeftoverE2eProcesses("setup", join(dirname(fileURLToPath(import.meta.url)), "..", ".."))
}
