import { DaemonClient } from "@pi-lab/pty-daemon"

// The synchronous probe lives in a light module so the startup entry can load
// it without the daemon client.
export { ALPHA_RESET_PROBE_FLAG, assertAlphaResetDaemonIdleSync } from "./alphaResetProbe"

/**
 * Refuse a new-build Alpha reset while prior terminals or jobs are alive.
 * Connect only to an existing daemon, never spawn or terminate one, and leave
 * its sessions untouched if inspection fails or exceeds three seconds.
 */
export async function assertAlphaResetDaemonIdle(socketPath: string): Promise<void> {
  const client = new DaemonClient(socketPath)
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const inspection = (async () => {
    const connected = await client.connect().then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ECONNREFUSED") return false
        throw error
      },
    )
    if (!connected) return
    if (expired) {
      client.close()
      return
    }
    const [sessions, processes] = await Promise.all([client.list(), client.listProcesses()])
    if (sessions.some(({ alive }) => alive) || processes.some(({ alive }) => alive))
      throw new Error(
        "Close Alpha terminals and background jobs in the previous build before opening this new build. Their app records have been left untouched.",
      )
  })()
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true
      reject(
        new Error(
          "Checking prior Alpha terminals and jobs timed out. Close them in the previous build, then retry; the app data has been left untouched.",
        ),
      )
    }, 3000)
  })
  try {
    await Promise.race([inspection, timeout])
  } finally {
    if (timer) clearTimeout(timer)
    client.close()
  }
}
