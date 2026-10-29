import { execFileSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Finds and stops processes left behind by an interrupted e2e run (Playwright
 * killed mid-test leaves the app it launched, its helpers, and its pty-daemon
 * running). Used by the Playwright globalSetup and globalTeardown.
 */

/** One row of the process table. */
export interface ProcessEntry {
  pid: number
  ppid: number
  command: string
}

/** Temp dir name prefixes the e2e specs pass to `mkdtemp`. */
const TEMP_PREFIXES = ["pi-lab-", "pi-update-feedback-"]

/**
 * Orphaned processes of this repo's e2e runs, from a process table.
 *
 * A process is from this repo's tests when its executable is the repo's
 * node_modules Electron (`<repo>/node_modules/.bun/electron@…`, which also runs
 * the helpers and the pty-daemon) or its command runs the repo's built daemon
 * (`<repo>/apps/desktop/out/pty-daemon/index.js`), and its command line names a
 * test temp dir (`<tmp>/pi-lab-…` or `<tmp>/pi-update-feedback-…`). The
 * Electron main process has no data path on its command line, so it belongs to
 * the test dir its direct children (helpers) name.
 *
 * Only orphans are returned, so a live run in the same checkout is never
 * touched:
 * - an app (main and helpers) is orphaned when the main's parent is not a live
 *   Playwright process (worker or runner), for example launchd after the run
 *   was killed;
 * - a pty-daemon (detached, so its parent can be launchd while its app lives)
 *   is stopped only when no other Playwright run of this checkout is live: no
 *   node Playwright process whose command names `<repo>/node_modules/` exists
 *   outside the run `ownRun` (the cleaning run's runner pid and its
 *   descendants). In teardown the own runner is still alive, so it is excluded.
 * Installed apps and release builds never match: their executables are outside
 * these paths.
 */
export function leftoverE2eProcesses(
  processes: ProcessEntry[],
  repoRoot: string,
  tmpRoots: string[],
  ownRun: number,
): ProcessEntry[] {
  const electronPrefix = `${repoRoot}/node_modules/.bun/electron@`
  const daemonEntry = `${repoRoot}/apps/desktop/out/pty-daemon/index.js `
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]))
  const isDaemon = (entry: ProcessEntry): boolean => entry.command.includes(daemonEntry)
  const isElectron = (entry: ProcessEntry): boolean => entry.command.startsWith(electronPrefix)
  const isMain = (entry: ProcessEntry): boolean =>
    isElectron(entry) &&
    !isDaemon(entry) &&
    !entry.command.includes(" --type=") &&
    !entry.command.includes("/Electron Helper")
  /** Name of the test temp dir the command names, if any. */
  const testDir = (entry: ProcessEntry): string | undefined => {
    for (const root of tmpRoots)
      for (const prefix of TEMP_PREFIXES) {
        const at = entry.command.indexOf(`${root}/${prefix}`)
        if (at >= 0) return /^[^/\s]+/.exec(entry.command.slice(at + root.length + 1))?.[0]
      }
    return undefined
  }
  const children = (pid: number): ProcessEntry[] => processes.filter((entry) => entry.ppid === pid)
  const fromPlaywright = (entry: ProcessEntry): boolean =>
    byPid.get(entry.ppid)?.command.includes("playwright") === true

  // Test apps: each main with the test dir its helpers name.
  const apps = processes
    .filter(isMain)
    .map((main) => {
      const helpers = children(main.pid).filter((child) => isElectron(child) && !isDaemon(child))
      const dir = testDir(main) ?? helpers.map(testDir).find((name) => name !== undefined)
      return { main, helpers, dir, live: fromPlaywright(main) }
    })
    .filter((app) => app.dir !== undefined)
  const inOwnRun = (entry: ProcessEntry): boolean => {
    let current: ProcessEntry | undefined = entry
    // pid 0 is its own parent on macOS.
    while (current && current.pid !== current.ppid) {
      if (current.pid === ownRun) return true
      current = byPid.get(current.ppid)
    }
    return current?.pid === ownRun
  }
  const otherRunLive = processes.some(
    (entry) =>
      /^(\S*\/)?node\s/.test(entry.command) &&
      entry.command.includes("playwright") &&
      entry.command.includes(`${repoRoot}/node_modules/`) &&
      !inOwnRun(entry),
  )
  const appPids = new Set(apps.flatMap((app) => [app.main.pid, ...app.helpers.map((h) => h.pid)]))

  const orphans = new Set<number>()
  for (const app of apps.filter((item) => !item.live))
    for (const entry of [app.main, ...app.helpers]) orphans.add(entry.pid)
  for (const entry of processes) {
    const dir = testDir(entry)
    if (dir === undefined || appPids.has(entry.pid)) continue
    // Daemons only when no other run of this checkout could still own them.
    if (isDaemon(entry) && !otherRunLive) orphans.add(entry.pid)
    // A helper whose main is gone.
    if (isElectron(entry) && !isDaemon(entry) && !byPid.has(entry.ppid)) orphans.add(entry.pid)
  }
  return processes.filter((entry) => orphans.has(entry.pid))
}

/** The current process table, from `ps`. */
function listProcesses(): ProcessEntry[] {
  const output = execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8" })
  return output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      if (!match) throw new Error(`Unexpected ps line: ${line}`)
      return { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }
    })
}

/**
 * Pid of the Playwright runner this code runs in: walking up from this process,
 * the last of the unbroken chain of node processes whose command names
 * Playwright. A parent shell is never included, even when its command text
 * names Playwright, so two runs started from one shell stay separate.
 */
function ownRunPid(processes: ProcessEntry[]): number {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]))
  const playwrightNode = (entry: ProcessEntry): boolean =>
    /^(\S*\/)?node\s/.test(entry.command) && entry.command.includes("playwright")
  let run = process.pid
  let current = byPid.get(byPid.get(process.pid)?.ppid ?? -1)
  while (current && current.pid !== current.ppid && playwrightNode(current)) {
    run = current.pid
    current = byPid.get(current.ppid)
  }
  return run
}

/** Whether a process exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

/** Sends `signal` unless the process already exited. */
function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

/**
 * Stops leftover e2e processes: SIGTERM first (the daemon then stops its PTY
 * children), SIGKILL for any still running after 5 seconds. Logs each one.
 */
export async function stopLeftoverE2eProcesses(when: string, repoRoot: string): Promise<void> {
  if (process.platform === "win32") {
    console.log(`[e2e cleanup, ${when}] skipped on Windows (no ps)`)
    return
  }
  const tmp = tmpdir()
  const tmpRoots = [...new Set([tmp, realpathSync(tmp), join("/private", tmp)])]
  const processes = listProcesses()
  const leftovers = leftoverE2eProcesses(processes, repoRoot, tmpRoots, ownRunPid(processes))
  if (leftovers.length === 0) return
  for (const entry of leftovers) {
    console.log(`[e2e cleanup, ${when}] stopping pid ${entry.pid}: ${entry.command.slice(0, 160)}`)
    signal(entry.pid, "SIGTERM")
  }
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && leftovers.some((entry) => alive(entry.pid)))
    await new Promise((resolve) => setTimeout(resolve, 100))
  for (const entry of leftovers.filter((item) => alive(item.pid))) {
    console.log(`[e2e cleanup, ${when}] pid ${entry.pid} ignored SIGTERM; sending SIGKILL`)
    signal(entry.pid, "SIGKILL")
  }
}
