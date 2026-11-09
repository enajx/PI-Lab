// Tests for the Overleaf Git auth helpers. The askpass test runs the real
// written script the same way git does (one prompt argument, answer on stdout).
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, expect, test } from "vitest"
import {
  displayRemoteUrl,
  gitHasOverleafCredential,
  isOverleafUrl,
  remoteEnv,
  writeAskpassScript,
} from "./overleaf"

const execFileAsync = promisify(execFile)
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-lab-askpass-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test("isOverleafUrl accepts only the git.overleaf.com host", () => {
  expect(isOverleafUrl("https://git@git.overleaf.com/6ae5e243374fe1802d83e27a")).toBe(true)
  expect(isOverleafUrl("https://git.overleaf.com/6ae5e243374fe1802d83e27a")).toBe(true)
  expect(isOverleafUrl("https://github.com/user/paper.git")).toBe(false)
  expect(isOverleafUrl("https://git.overleaf.com.evil.example/x")).toBe(false)
  expect(isOverleafUrl("git@github.com:user/paper.git")).toBe(false)
  expect(isOverleafUrl("/tmp/overleaf.git")).toBe(false)
  expect(isOverleafUrl("http://git.overleaf.com/6ae5e243374fe1802d83e27a")).toBe(false)
})

test("displayRemoteUrl strips embedded credentials but keeps a bare git@ user", () => {
  expect(displayRemoteUrl("https://user:secret@example.com/x.git")).toBe(
    "https://example.com/x.git",
  )
  expect(displayRemoteUrl("https://olp_x@git.overleaf.com/abc")).toBe(
    "https://git.overleaf.com/abc",
  )
  expect(displayRemoteUrl("https://git:secret@git.overleaf.com/abc")).toBe(
    "https://git.overleaf.com/abc",
  )
  expect(displayRemoteUrl("https://git@git.overleaf.com/abc")).toBe(
    "https://git@git.overleaf.com/abc",
  )
  expect(displayRemoteUrl("git@github.com:u/p.git")).toBe("git@github.com:u/p.git")
  expect(displayRemoteUrl("/tmp/overleaf.git")).toBe("/tmp/overleaf.git")
})

test("askpass script answers git for Username and the token for Password", async () => {
  const script = await writeAskpassScript(dir)
  const env = { ...process.env, PI_LAB_OVERLEAF_TOKEN: "olp_secret" }
  const user = await execFileAsync(script, ["Username for 'https://git.overleaf.com': "], { env })
  const pass = await execFileAsync(script, ["Password for 'https://git@git.overleaf.com': "], {
    env,
  })
  expect(user.stdout).toBe("git\n")
  expect(pass.stdout).toBe("olp_secret\n")
})

test("remoteEnv passes the saved token only for an Overleaf remote", () => {
  const saved = { source: "saved", token: "olp_secret", askpassPath: "/x/askpass.sh" } as const
  const overleaf = remoteEnv(["https://git@git.overleaf.com/abc"], saved)
  expect(overleaf).toEqual({
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/x/askpass.sh",
    PI_LAB_OVERLEAF_TOKEN: "olp_secret",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
  })
  const other = remoteEnv(["https://github.com/u/p.git"], saved)
  expect(other).toEqual({ GIT_TERMINAL_PROMPT: "0" })
  expect(JSON.stringify(other)).not.toContain("olp_secret")
})

test("remoteEnv with Git credentials keeps the user's credential helper and injects no token", () => {
  expect(remoteEnv(["https://git.overleaf.com/abc"], { source: "git" })).toEqual({
    GIT_TERMINAL_PROMPT: "0",
  })
})

test("remoteEnv refuses an Overleaf remote without a token", () => {
  expect(() => remoteEnv(["https://git.overleaf.com/abc"], null)).toThrow("overleaf-token-required")
})

test("remoteEnv gives the token only when every URL (fetch and push) is Overleaf", () => {
  const mixed = remoteEnv(["https://git.overleaf.com/abc", "https://evil.example/collect"], {
    source: "saved",
    token: "olp_secret",
    askpassPath: "/x/askpass.sh",
  })
  expect(mixed).toEqual({ GIT_TERMINAL_PROMPT: "0" })
  expect(() =>
    remoteEnv(["https://git.overleaf.com/abc", "https://git.overleaf.com/abc"], null),
  ).toThrow("overleaf-token-required")
})

/**
 * Environment for a git call that sees only the test's own global config:
 * HOME and GIT_CONFIG_GLOBAL point into the temp dir and the system config
 * (which holds osxkeychain on macOS) is skipped, so the real keychain is never read.
 */
function isolatedGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: dir,
    GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  }
}

/** Configure a test credential helper script that answers only for git.overleaf.com. */
async function useTestHelper(): Promise<void> {
  const helper = join(dir, "test-credential-helper.sh")
  await writeFile(
    helper,
    `#!/bin/sh
[ "$1" = get ] || exit 0
host=""
while IFS= read -r line && [ -n "$line" ]; do
  case "$line" in host=*) host="\${line#host=}" ;; esac
done
[ "$host" = git.overleaf.com ] || exit 0
printf 'username=git\npassword=helper-secret\n'
`,
    { mode: 0o700 },
  )
  await execFileAsync("git", [
    "config",
    "--file",
    join(dir, "gitconfig"),
    "credential.helper",
    helper,
  ])
}

test("gitHasOverleafCredential finds a credential from the Git credential helper (test helper)", async () => {
  await writeFile(join(dir, "gitconfig"), "")
  expect(await gitHasOverleafCredential(isolatedGitEnv())).toBe(false)
  await useTestHelper()
  expect(await gitHasOverleafCredential(isolatedGitEnv())).toBe(true)
})

test("gitHasOverleafCredential never prompts when no helper answers", async () => {
  await writeFile(join(dir, "gitconfig"), "")
  // A GIT_ASKPASS that would answer must not be used by the lookup.
  const answering = join(dir, "answering-askpass.sh")
  await writeFile(answering, "#!/bin/sh\necho prompted-secret\n", { mode: 0o700 })
  expect(await gitHasOverleafCredential({ ...isolatedGitEnv(), GIT_ASKPASS: answering })).toBe(
    false,
  )
})
