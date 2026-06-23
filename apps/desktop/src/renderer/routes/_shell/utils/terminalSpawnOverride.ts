/**
 * Test seam (AGENTS.md §14): let the E2E spawn the terminal with a deterministic
 * program via URL query params (`?termcmd=…&termargs=<json-array>`), so the
 * harness can assert a known marker without typing into the grid. In normal use
 * no params are present and the terminal falls back to the login shell.
 */
export function readTerminalSpawnOverride(): { command?: string; args?: string[] } | null {
  if (typeof window === "undefined") return null
  const params = new URLSearchParams(window.location.search)
  const command = params.get("termcmd")
  if (!command) return null
  const rawArgs = params.get("termargs")
  let args: string[] | undefined
  if (rawArgs) {
    try {
      const parsed: unknown = JSON.parse(rawArgs)
      if (Array.isArray(parsed) && parsed.every((a) => typeof a === "string")) args = parsed
    } catch {
      // Ignore malformed args; spawn the command bare.
    }
  }
  return { command, args }
}
