import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { afterAll, beforeAll, expect, it } from "vitest"
import { MachineConnections } from "../../apps/desktop/src/main/machines/machineConnections"
import type { BehindPolicy } from "../../apps/desktop/src/main/machines/machineStore"
import type { RemoteAccess } from "../../apps/desktop/src/main/machines/remoteShell"
import type { ServerBundleFiles } from "../../apps/desktop/src/main/machines/serverBundle"
import { connectServer } from "../e2e/fixtures/serverClient"
import { type SshTestServer, startSshTestServer } from "../support/sshTestServer"
import {
  type BuiltBundle,
  buildBundle,
  INSTALLER,
  killProcessesUnder,
  repackBundle,
  tempDir,
} from "./bundleFixture"

/**
 * The app-side backup update (step 1 plan, PR 3, updates B3): the app's
 * MachineConnections (driven from vitest, no Electron) reaches a machine with
 * server v1 over real ssh (a user-level test sshd on this Mac) while it
 * carries bundle v2. "Ask me": the machine shows an update and stays on v1.
 * "Update automatically": the app installs v2 over ssh and connects again.
 */

let root: string
let sshd: SshTestServer
let v1: BuiltBundle
let v2: BuiltBundle

beforeAll(async () => {
  root = await tempDir("pi-um-")
  v1 = buildBundle("0.0.1-updatetest", root)
  v2 = repackBundle(v1, "0.0.2-updatetest", `${v1.build.slice(0, 15)}2`, root, null)
  sshd = await startSshTestServer("127.0.0.1")
})

afterAll(async () => {
  await sshd?.stop()
  killProcessesUnder(root)
  await rm(root, { recursive: true, force: true })
})

it("updates a machine that is behind the bundle this app carries", async () => {
  const remoteData = join(root, "d")
  const profile = join(root, "profile")
  mkdirSync(profile)
  const access: RemoteAccess = {
    sshPath: "/usr/bin/ssh",
    extraSshArgs: sshd.clientArgs,
    dataDir: remoteData,
    serverPrefix: join(root, "prefix"),
    appPath: join(root, "no-app", "PI Lab.app"),
    enrollCommand: "false",
    installArgs: ["--no-launchd"],
    installEnv: { PI_LAB_TEST_MODE: "1", PI_LAB_TEST_SKILLS_HOME: join(root, "skills-home") },
  }
  const files = (bundle: BuiltBundle): ServerBundleFiles => ({
    tarball: bundle.tarball,
    sha256File: `${bundle.tarball}.sha256`,
    installer: INSTALLER,
    version: bundle.version,
  })
  const connections = (bundle: BuiltBundle) =>
    new MachineConnections({
      profileDir: profile,
      access,
      deviceName: "PI Lab on the test Mac",
      localMachineId: async () => "not-this-machine",
      bundle: () => files(bundle),
      log: () => undefined,
    })
  const helloVersion = async (live: MachineConnections, machineId: string): Promise<string> => {
    const { url } = await live.endpoint(machineId)
    const client = connectServer(remoteData, decodeURIComponent(url.split("token=")[1] ?? ""))
    const hello = await client.client.server.hello.query()
    client.close()
    return hello.version
  }

  // The machine gets v1 from an app that carries v1.
  const first = connections(v1)
  expect(first.behindPolicy()).toBe<BehindPolicy>("auto")
  const added = await first.add({ sshHost: sshd.host, name: "Test Mac" }, () => undefined)
  expect(added.state, added.error ?? "").toBe("connected")
  expect(added).toMatchObject({ version: v1.version, updateAvailable: false })
  await first.close()

  // "Ask me": an app carrying v2 offers the update and does not install it.
  const asking = connections(v2)
  asking.setBehindPolicy("ask")
  asking.start()
  await expect.poll(() => asking.list()[0]?.state, { timeout: 60_000 }).toBe("connected")
  expect(asking.list()[0]).toMatchObject({
    version: v1.version,
    updateAvailable: true,
    updating: false,
  })
  expect(await helloVersion(asking, added.machineId)).toBe(v1.version)
  await asking.close()

  // A version that did not start there before is refused, shown as the update error.
  const failedVersions = join(access.serverPrefix, "failed-versions")
  writeFileSync(failedVersions, `${v2.version}\n`)
  const refused = connections(v2)
  refused.setBehindPolicy("auto")
  refused.start()
  await expect
    .poll(() => refused.list()[0]?.updateError ?? "", { timeout: 120_000, interval: 500 })
    .toContain("did not start before")
  expect(refused.list()[0]).toMatchObject({ version: v1.version, updating: false })
  await refused.close()
  rmSync(failedVersions)

  // "Update automatically": the app installs v2 over ssh and connects again.
  const auto = connections(v2)
  auto.setBehindPolicy("auto")
  auto.start()
  // The update shows its step in the machine's summary while it runs.
  const steps = new Set<string>()
  const sample = setInterval(() => {
    const step = auto.list()[0]?.updateProgress?.step
    if (step) steps.add(step)
  }, 20)
  await expect
    .poll(() => auto.list()[0], { timeout: 240_000, interval: 500 })
    .toMatchObject({
      version: v2.version,
      updating: false,
      updateError: null,
      updateProgress: null,
    })
  clearInterval(sample)
  expect(steps).toContain("installing")
  expect(auto.list()[0]?.updateAvailable).toBe(false)
  expect(await helloVersion(auto, added.machineId)).toBe(v2.version)
  await auto.close()
})
