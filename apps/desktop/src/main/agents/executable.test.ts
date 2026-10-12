import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"

const originalShell = process.env.SHELL
let probeDir: string | null = null

afterEach(() => {
  if (originalShell === undefined) delete process.env.SHELL
  else process.env.SHELL = originalShell
  if (probeDir) rmSync(probeDir, { recursive: true, force: true })
  probeDir = null
  vi.resetModules()
})

test.skipIf(process.platform === "win32")(
  "retries a failed login-shell probe before agent launch",
  async () => {
    probeDir = mkdtempSync(join(tmpdir(), "pi-lab-login-probe-"))
    const shellPath = join(probeDir, "shell")
    const agentPath = join(probeDir, "test-agent")
    writeFileSync(agentPath, "#!/bin/sh\nexit 0\n")
    chmodSync(agentPath, 0o700)
    writeFileSync(shellPath, "#!/bin/sh\nexit 1\n")
    chmodSync(shellPath, 0o700)
    process.env.SHELL = shellPath

    const { liveAgentExecutableResolver } = await import("./executable")
    await expect(liveAgentExecutableResolver("test-agent")).rejects.toThrow()

    writeFileSync(shellPath, `#!/bin/sh\nprintf 'PATH=${probeDir}\\000'\n`)
    await expect(liveAgentExecutableResolver("test-agent")).resolves.toBe(agentPath)
  },
)
