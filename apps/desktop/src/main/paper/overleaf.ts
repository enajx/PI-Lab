import { execFile } from "node:child_process"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { TRPCError } from "@trpc/server"

/**
 * Overleaf Git authentication. Overleaf asks for user name `git` and a Git
 * token as the password. A token saved in PI Lab is given to git with a small
 * GIT_ASKPASS script that reads it from an environment variable set only for
 * the git call, so the token never appears in a command line or a file.
 * Without a saved token, PI Lab uses a credential the user's own Git already
 * has for git.overleaf.com (for example in the macOS keychain from an earlier
 * `git clone`): git calls then run with the user's credential helper, and PI
 * Lab never reads, stores or returns that secret.
 */

/** Host of Overleaf's Git bridge. */
export const OVERLEAF_HOST = "git.overleaf.com"

/** Environment variable the askpass script reads the token from. */
export const OVERLEAF_TOKEN_ENV = "PI_LAB_OVERLEAF_TOKEN"

/** Error message for Sync (or an agent merge) on a paper linked with Sync off. */
export const SYNC_OFF_MESSAGE =
  "Sync is off for this paper: it is the project folder, used for editing and building only."

/** Throw PRECONDITION_FAILED when `syncEnabled` is false (the paper was linked with Sync off). */
export function requireSyncEnabled(syncEnabled: boolean | undefined): void {
  if (syncEnabled === false) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: SYNC_OFF_MESSAGE })
  }
}

/** Error message the renderer matches to ask the user for a token. */
export const OVERLEAF_TOKEN_REQUIRED = "overleaf-token-required"

const ASKPASS_SCRIPT = `#!/bin/sh
# Written by PI Lab. Answers Git's Overleaf credential prompts.
case "$1" in
  Username*) printf '%s\\n' git ;;
  *) printf '%s\\n' "$${OVERLEAF_TOKEN_ENV}" ;;
esac
`

/** Where the Overleaf credential comes from: a token saved in PI Lab, or the user's Git. */
export type OverleafTokenSource = "saved" | "git"

/** Result of `paper.token.status`. The token itself is never included. */
export interface OverleafTokenStatus {
  configured: boolean
  /** "saved" wins over "git"; null when neither exists. */
  source: OverleafTokenSource | null
}

/**
 * How an Overleaf git call authenticates: the saved token through our askpass
 * script, the user's own Git credential helper, or nothing (null).
 */
export type OverleafAuth =
  | { source: "saved"; token: string; askpassPath: string }
  | { source: "git" }
  | null

/** Longest wait for the Git credential lookup (a credential helper may be slow). */
const GIT_CREDENTIAL_TIMEOUT_MS = 10_000

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
 * Ask the user's Git whether it has a credential for git.overleaf.com with
 * user name `git`, the user name Overleaf tokens use. Runs `git credential
 * fill` with `env` (normally `process.env`), so the user's configured
 * credential helpers answer. Git never prompts: terminal prompts are off and
 * GIT_ASKPASS is `true`, which answers with an empty password. Only whether a
 * non-empty password came back is returned; the secret itself is dropped.
 * Throws when git fails or the lookup times out.
 */
export function gitHasOverleafCredential(env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((done, reject) => {
    const child = execFile(
      "git",
      ["credential", "fill"],
      {
        env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" },
        timeout: GIT_CREDENTIAL_TIMEOUT_MS,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          const reason = error.killed
            ? `timed out after ${GIT_CREDENTIAL_TIMEOUT_MS / 1000} s`
            : stderr.trim() || error.message
          reject(new Error(`Could not check Git credentials for ${OVERLEAF_HOST}: ${reason}`))
          return
        }
        done(stdout.split("\n").some((line) => /^password=.+/.test(line)))
      },
    )
    child.stdin?.end(`protocol=https\nhost=${OVERLEAF_HOST}\nusername=git\n\n`)
  })
}

/**
 * Environment for a git call that talks to `urls` (the remote's fetch and push
 * URLs). Every call disables the terminal prompt so git fails instead of
 * waiting for input. Only when every URL is Overleaf does `auth` apply;
 * otherwise the call runs with the user's own git config, so the token is
 * never sent to another host. With a saved token the call gets the askpass
 * script and the token, and the credential helpers are turned off for that
 * call, so a stale saved password (for example in the macOS keychain) is not
 * used and the token is not saved there. With "git" the call uses the user's
 * own credential helper unchanged and gets no token. Throws
 * PRECONDITION_FAILED "overleaf-token-required" for an Overleaf remote when
 * `auth` is null.
 */
export function remoteEnv(urls: string[], auth: OverleafAuth): Record<string, string> {
  if (urls.length === 0 || !urls.every(isOverleafUrl)) return { GIT_TERMINAL_PROMPT: "0" }
  if (!auth) throw new TRPCError({ code: "PRECONDITION_FAILED", message: OVERLEAF_TOKEN_REQUIRED })
  if (auth.source === "git") return { GIT_TERMINAL_PROMPT: "0" }
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: auth.askpassPath,
    [OVERLEAF_TOKEN_ENV]: auth.token,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
  }
}
