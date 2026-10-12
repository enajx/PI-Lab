import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { delimiter, isAbsolute, join } from "node:path"
import { promisify } from "node:util"

export type AgentExecutableResolver = (candidate: string) => Promise<string | null>
export type AgentLaunchEnvironmentResolver = () => Promise<Record<string, string>>

const execFileAsync = promisify(execFile)
let loginEnvironment: Promise<Record<string, string>> | null = null

function parseNullEnvironment(stdout: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const entry of stdout.split("\0")) {
    const separator = entry.indexOf("=")
    if (separator <= 0) continue
    result[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  return result
}

/**
 * Capture the user's login-shell environment once. Plain project terminals
 * start that same login shell; passing this environment to direct agent PTYs
 * makes GUI launches see the same PATH and manager exports.
 */
export const liveAgentLaunchEnvironment: AgentLaunchEnvironmentResolver = () => {
  if (process.platform === "win32") {
    return Promise.resolve(
      Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    )
  }
  if (!loginEnvironment) {
    const shell = process.env.SHELL?.trim() || "/bin/bash"
    const probe = execFileAsync(shell, ["-ilc", "env -0"], {
      env: process.env,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 5_000,
    }).then(
      ({ stdout }) =>
        ({ ...process.env, ...parseNullEnvironment(stdout) }) as Record<string, string>,
    )
    const cached = probe.catch((error: unknown) => {
      if (loginEnvironment === cached) loginEnvironment = null
      throw error
    })
    loginEnvironment = cached
  }
  return loginEnvironment
}

/**
 * Resolve the exact executable the PTY will spawn against the Electron main
 * process environment inherited by the terminal daemon.
 */
export const liveAgentExecutableResolver: AgentExecutableResolver = async (candidate) => {
  const environment = await liveAgentLaunchEnvironment()
  const names =
    process.platform === "win32" && !candidate.toLowerCase().endsWith(".exe")
      ? [candidate, `${candidate}.exe`, `${candidate}.cmd`, `${candidate}.bat`]
      : [candidate]
  const paths = isAbsolute(candidate)
    ? names
    : (environment.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .flatMap((dir) => names.map((name) => join(dir, name)))

  for (const path of paths) {
    const available = await access(path, constants.X_OK).then(
      () => true,
      () => false,
    )
    if (available) return path
  }
  return null
}
