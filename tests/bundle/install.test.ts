import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { afterAll, beforeAll, expect, it } from "vitest"
import { headlessServerEnv } from "../e2e/fixtures/headlessServer"
import { connectServer, readServerDiscovery } from "../e2e/fixtures/serverClient"
import {
  type BuiltBundle,
  buildBundle,
  DESKTOP_DIR,
  INSTALLER,
  installEnv,
  killProcessesUnder,
  repackBundle,
  runInstall,
  tempDir,
} from "./bundleFixture"

/**
 * install.sh (step 1 plan, PR 3): installs a server bundle from a file into a
 * temp prefix and data folder with `--no-launchd`, starts it, switches
 * `current`, keeps one previous version, and refuses where it must.
 */

let root: string
let bundles: BuiltBundle[]

beforeAll(async () => {
  root = await tempDir("pi-lab-install-")
  const first = buildBundle("0.0.1-installtest", root)
  bundles = [
    first,
    repackBundle(first, "0.0.2-installtest", `${first.build.slice(0, 15)}2`, root, null),
    repackBundle(first, "0.0.3-installtest", `${first.build.slice(0, 15)}3`, root, null),
  ]
})

afterAll(async () => {
  killProcessesUnder(root)
  await rm(root, { recursive: true, force: true })
})

/** A fresh home, prefix and data folder for one test. */
function setup(name: string) {
  const dir = join(root, name)
  const home = join(dir, "home")
  const prefix = join(dir, "prefix")
  const dataDir = join(dir, "data")
  mkdirSync(home, { recursive: true })
  const args = (bundle: BuiltBundle) => [
    "--from-file",
    bundle.tarball,
    "--prefix",
    prefix,
    "--data-dir",
    dataDir,
    "--no-launchd",
  ]
  return { dir, home, prefix, dataDir, args, env: installEnv(home, {}) }
}

async function helloVersion(dataDir: string): Promise<string> {
  const client = connectServer(dataDir)
  const hello = await client.client.server.hello.query()
  client.close()
  return hello.version
}

it("installs a bundle, then a newer one, keeping one previous version", async () => {
  const t = setup("upgrade")
  const [v1, v2, v3] = bundles as [BuiltBundle, BuiltBundle, BuiltBundle]

  const first = await runInstall(INSTALLER, t.args(v1), t.env)
  expect(first.stderr).toContain("runs (pid")
  expect(first.code).toBe(0)
  expect(await helloVersion(t.dataDir)).toBe(v1.version)
  expect(readlinkSync(join(t.prefix, "current"))).toBe(`versions/${v1.version}`)
  const firstPid = readServerDiscovery(t.dataDir)?.pid

  const second = await runInstall(INSTALLER, t.args(v2), t.env)
  expect(second.code, second.stderr).toBe(0)
  expect(await helloVersion(t.dataDir)).toBe(v2.version)
  expect(readServerDiscovery(t.dataDir)?.pid).not.toBe(firstPid)
  expect(readlinkSync(join(t.prefix, "current"))).toBe(`versions/${v2.version}`)
  expect(readlinkSync(join(t.prefix, "previous"))).toBe(`versions/${v1.version}`)
  expect(readdirSync(join(t.prefix, "versions")).sort()).toEqual([v1.version, v2.version])

  const third = await runInstall(INSTALLER, t.args(v3), t.env)
  expect(third.code, third.stderr).toBe(0)
  expect(await helloVersion(t.dataDir)).toBe(v3.version)
  expect(readlinkSync(join(t.prefix, "previous"))).toBe(`versions/${v2.version}`)
  expect(readdirSync(join(t.prefix, "versions")).sort()).toEqual([v2.version, v3.version])
  // The test never wrote a launchd agent.
  expect(existsSync(join(t.home, "Library", "LaunchAgents"))).toBe(false)
})

it("refuses a bundle whose SHA-256 does not match", async () => {
  const t = setup("bad-sum")
  const bundle = bundles[0] as BuiltBundle
  const copy = join(t.dir, "copy.tar.gz")
  mkdirSync(t.dir, { recursive: true })
  writeFileSync(copy, "not the bundle")
  writeFileSync(`${copy}.sha256`, `${"0".repeat(64)}  copy.tar.gz\n`)
  const result = await runInstall(
    INSTALLER,
    [...t.args(bundle).slice(2), "--from-file", copy],
    t.env,
  )
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("SHA-256")
  expect(existsSync(join(t.prefix, "current"))).toBe(false)
})

it("refuses Linux", async () => {
  const t = setup("linux")
  const shims = join(t.dir, "shims")
  mkdirSync(shims, { recursive: true })
  writeFileSync(join(shims, "uname"), "#!/bin/sh\necho Linux\n")
  chmodSync(join(shims, "uname"), 0o755)
  const env = { ...t.env, PATH: `${shims}:${t.env.PATH}` }
  const result = await runInstall(INSTALLER, t.args(bundles[0] as BuiltBundle), env)
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("Linux comes in step 3")
})

it("refuses when a desktop app server already serves the data folder", async () => {
  const t = setup("app-server")
  mkdirSync(t.dataDir, { recursive: true })
  const serverEntry = join(DESKTOP_DIR, "out", "main", "server.js")
  const env = headlessServerEnv({
    dataDir: t.dataDir,
    resourcesDir: join(DESKTOP_DIR, "resources"),
    serverEntry,
  })
  const app: ChildProcess = spawn(process.execPath, [serverEntry, t.dataDir], {
    env,
    stdio: "ignore",
  })
  const deadline = Date.now() + 60_000
  while (readServerDiscovery(t.dataDir) === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const result = await runInstall(INSTALLER, t.args(bundles[0] as BuiltBundle), t.env)
  app.kill("SIGTERM")
  expect(result.code).toBe(3)
  expect(result.stderr).toContain("PI Lab uses that server")
  expect(existsSync(join(t.prefix, "current"))).toBe(false)
})

it("a failed version rolls back without an older database copy, and is not installed again", async () => {
  const t = setup("failed-version")
  const [v1] = bundles as [BuiltBundle]
  const broken = repackBundle(
    v1,
    "0.0.9-installtest",
    `${v1.build.slice(0, 15)}9`,
    t.dir,
    (dir) => {
      writeFileSync(join(dir, "bin", "pi-lab-server"), "#!/bin/sh\nexit 1\n")
    },
  )
  expect((await runInstall(INSTALLER, t.args(v1), t.env)).code).toBe(0)
  // A copy of the broken build's database left by an earlier install: never restored.
  const stale = join(t.dataDir, `local.db.pre-${broken.build}`)
  writeFileSync(stale, "an older copy")

  const failed = await runInstall(INSTALLER, t.args(broken), t.env)
  expect(failed.code, failed.stderr).toBe(1)
  expect(failed.stderr).toContain("runs again")
  expect(readFileSync(join(t.dataDir, "local.db"), "utf8")).not.toBe("an older copy")
  expect(await helloVersion(t.dataDir)).toBe(v1.version)
  expect(readFileSync(join(t.prefix, "failed-versions"), "utf8")).toContain(broken.version)

  const pid = readServerDiscovery(t.dataDir)?.pid
  const again = await runInstall(INSTALLER, t.args(broken), t.env)
  expect(again.code, again.stderr).toBe(4)
  expect(again.stderr).toContain("did not start before")
  expect(again.stderr).toContain(join(t.prefix, "failed-versions"))
  expect(readServerDiscovery(t.dataDir)?.pid).toBe(pid)
})

it("refuses while another install holds the prefix's lock", async () => {
  const t = setup("locked")
  mkdirSync(join(t.prefix, "install.lock"), { recursive: true })
  // The other install is a live process (this test runner).
  writeFileSync(join(t.prefix, "install.lock", "pid"), `${process.pid}\n`)
  const result = await runInstall(INSTALLER, t.args(bundles[0] as BuiltBundle), t.env)
  expect(result.code, result.stderr).toBe(5)
  expect(result.stderr).toContain(join(t.prefix, "install.lock"))
  expect(existsSync(join(t.prefix, "current"))).toBe(false)
  // The lock of the other install stays; after a finished install there is none.
  expect(existsSync(join(t.prefix, "install.lock"))).toBe(true)
  rmSync(join(t.prefix, "install.lock"), { recursive: true })
  expect((await runInstall(INSTALLER, t.args(bundles[0] as BuiltBundle), t.env)).code).toBe(0)
  expect(existsSync(join(t.prefix, "install.lock"))).toBe(false)
})

it("takes over a lock left by an install that no longer runs (killed, or a reboot)", async () => {
  const t = setup("stale-lock")
  mkdirSync(join(t.prefix, "install.lock"), { recursive: true })
  const gone = spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim()
  writeFileSync(join(t.prefix, "install.lock", "pid"), `${gone}\n`)
  const result = await runInstall(INSTALLER, t.args(bundles[0] as BuiltBundle), t.env)
  expect(result.code, result.stderr).toBe(0)
  expect(existsSync(join(t.prefix, "install.lock"))).toBe(false)
})
