import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { TRPCError } from "@trpc/server"

/**
 * Overleaf Git authentication. Overleaf asks for user name `git` and a Git
 * token as the password. We answer these prompts with a small GIT_ASKPASS
 * script that reads the token from an environment variable set only for the
 * git call, so the token never appears in a command line or a file.
 */

/** Host of Overleaf's Git bridge. */
export const OVERLEAF_HOST = "git.overleaf.com"

/** Environment variable the askpass script reads the token from. */
export const OVERLEAF_TOKEN_ENV = "PI_LAB_OVERLEAF_TOKEN"

/** Error message the renderer matches to ask the user for a token. */
export const OVERLEAF_TOKEN_REQUIRED = "overleaf-token-required"

const ASKPASS_SCRIPT = `#!/bin/sh
# Written by PI Lab. Answers Git's Overleaf credential prompts.
case "$1" in
  Username*) printf '%s\\n' git ;;
  *) printf '%s\\n' "$${OVERLEAF_TOKEN_ENV}" ;;
esac
`

/** True when `url` is an https URL whose host is exactly git.overleaf.com. */
export function isOverleafUrl(url: string): boolean {
  if (!/^https:\/\//i.test(url)) return false
  return new URL(url).hostname.toLowerCase() === OVERLEAF_HOST
}

/**
 * A remote URL safe to show in the renderer: credentials embedded in an
 * http(s) URL (`user:password@` or `token@`) are removed. A bare `git@` user
 * name is kept. Other URL forms (scp-like `git@host:path`, local paths) carry
 * no password and are returned unchanged.
 */
export function displayRemoteUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url
  const parsed = new URL(url)
  if (parsed.password === "" && (parsed.username === "" || parsed.username === "git")) return url
  parsed.username = ""
  parsed.password = ""
  return parsed.toString()
}

/** Write (or refresh) the askpass script in `dir` and return its path. */
export async function writeAskpassScript(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, "overleaf-askpass.sh")
  await writeFile(path, ASKPASS_SCRIPT, { mode: 0o700 })
  await chmod(path, 0o700)
  return path
}

/**
 * Environment for a git call that talks to `urls` (the remote's fetch and push
 * URLs). Every call disables the terminal prompt so git fails instead of
 * waiting for input. Only when every URL is Overleaf does the call get the
 * askpass script and the token; otherwise it runs with the user's own git
 * config, so the token is never sent to another host. For Overleaf the credential helpers are turned off
 * for that call, so a stale saved password (for example in the macOS
 * keychain) is not used and the token is not saved there. Throws PRECONDITION_FAILED "overleaf-token-required"
 * for an Overleaf remote when no token is saved.
 */
export function remoteEnv(
  urls: string[],
  token: string | null,
  askpassPath: string,
): Record<string, string> {
  if (urls.length === 0 || !urls.every(isOverleafUrl)) return { GIT_TERMINAL_PROMPT: "0" }
  if (!token) throw new TRPCError({ code: "PRECONDITION_FAILED", message: OVERLEAF_TOKEN_REQUIRED })
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: askpassPath,
    [OVERLEAF_TOKEN_ENV]: token,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
  }
}
