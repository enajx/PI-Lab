// Tests for the Overleaf Git auth helpers. The askpass test runs the real
// written script the same way git does (one prompt argument, answer on stdout).
import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, expect, test } from "vitest"
import { displayRemoteUrl, isOverleafUrl, remoteEnv, writeAskpassScript } from "./overleaf"

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

test("remoteEnv passes the token only for an Overleaf remote", () => {
  const overleaf = remoteEnv(["https://git@git.overleaf.com/abc"], "olp_secret", "/x/askpass.sh")
  expect(overleaf).toEqual({
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/x/askpass.sh",
    PI_LAB_OVERLEAF_TOKEN: "olp_secret",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
  })
  const other = remoteEnv(["https://github.com/u/p.git"], "olp_secret", "/x/askpass.sh")
  expect(other).toEqual({ GIT_TERMINAL_PROMPT: "0" })
  expect(JSON.stringify(other)).not.toContain("olp_secret")
})

test("remoteEnv refuses an Overleaf remote without a token", () => {
  expect(() => remoteEnv(["https://git.overleaf.com/abc"], null, "/x/askpass.sh")).toThrow(
    "overleaf-token-required",
  )
})

test("remoteEnv gives the token only when every URL (fetch and push) is Overleaf", () => {
  const mixed = remoteEnv(
    ["https://git.overleaf.com/abc", "https://evil.example/collect"],
    "olp_secret",
    "/x/askpass.sh",
  )
  expect(mixed).toEqual({ GIT_TERMINAL_PROMPT: "0" })
  expect(() =>
    remoteEnv(["https://git.overleaf.com/abc", "https://git.overleaf.com/abc"], null, ""),
  ).toThrow("overleaf-token-required")
})
