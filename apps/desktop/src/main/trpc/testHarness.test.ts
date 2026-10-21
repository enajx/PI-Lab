import { existsSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import { createHarness } from "./testHarness"

test("storage-only setup skips Git and starts the real daemon only when requested", async () => {
  const harness = await createHarness(undefined, { git: false, daemon: "lazy" })
  try {
    expect(existsSync(join(harness.repoDir, ".git"))).toBe(false)
    expect(existsSync(join(harness.dataDir, "daemon.sock"))).toBe(false)
    expect(await harness.caller.science.library.getStatus()).toEqual({ connected: false })
    const { sessionId } = await harness.caller.terminal.spawn({
      command: "/bin/cat",
      cwd: harness.repoDir,
      cols: 80,
      rows: 24,
    })
    expect((await harness.client.list()).some(({ id }) => id === sessionId)).toBe(true)
    await harness.caller.terminal.kill({ sessionId })
  } finally {
    await harness.dispose()
  }
})
