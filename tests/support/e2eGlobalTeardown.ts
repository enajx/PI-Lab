import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stopLeftoverE2eProcesses } from "./leftoverProcesses"

/** Playwright globalTeardown: stops any e2e processes this run left behind. */
export default async function globalTeardown(): Promise<void> {
  await stopLeftoverE2eProcesses(
    "teardown",
    join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
  )
}
