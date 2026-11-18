import { mkdirSync, readlinkSync, realpathSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { afterAll, beforeAll, expect, it } from "vitest"
import { MachineConnections } from "../../apps/desktop/src/main/machines/machineConnections"
import type { RemoteAccess } from "../../apps/desktop/src/main/machines/remoteShell"
import type { ServerBundleFiles } from "../../apps/desktop/src/main/machines/serverBundle"
import { connectServer, processAlive, readServerDiscovery } from "../e2e/fixtures/serverClient"
import { type SshTestServer, startSshTestServer } from "../support/sshTestServer"
import {
  type BuiltBundle,
  buildBundle,
  INSTALLER,
  killProcessesUnder,
  tempDir,
} from "./bundleFixture"

/**
 * "Add machine" on a Mac with no PI Lab server (step 1 plan, PR 3): the app's
 * MachineConnections (driven from vitest, no Electron) probes the remote over
 * real ssh (a user-level test sshd on this Mac), copies this app's server
 * bundle over and runs install.sh (`--no-launchd`, temp prefix and data
 * folder, test mode), then enrolls and connects. The server keeps running
 * after the app side closes. A second add finds the installed server and
 * does not install again.
 */

let root: string
let sshd: SshTestServer
let bundle: BuiltBundle

beforeAll(async () => {
  root = await tempDir("pi-lab-add-machine-")
  bundle = buildBundle("0.0.1-addtest", root)
  sshd = await startSshTestServer("127.0.0.1")
})

afterAll(async () => {
  await sshd?.stop()
  killProcessesUnder(root)
  await rm(root, { recursive: true, force: true })
})

it("installs this app's server bundle on a machine without PI Lab, then enrolls", async () => {
  const remoteData = join(root, "remote-data")
  const remotePrefix = join(root, "remote-prefix")
  const profile = join(root, "profile")
  mkdirSync(profile)
  const access: RemoteAccess = {
    sshPath: "/usr/bin/ssh",
    extraSshArgs: sshd.clientArgs,
    dataDir: remoteData,
    serverPrefix: remotePrefix,
    appPath: join(root, "no-app", "PI Lab.app"),
    enrollCommand: "false",
    installArgs: ["--no-launchd"],
    installEnv: { PI_LAB_TEST_MODE: "1", PI_LAB_TEST_SKILLS_HOME: join(root, "skills-home") },
  }
  const files: ServerBundleFiles = {
    tarball: bundle.tarball,
    sha256File: `${bundle.tarball}.sha256`,
    installer: INSTALLER,
    version: bundle.version,
  }
  const logs: string[] = []
  const connections = () =>
    new MachineConnections({
      profileDir: profile,
      access,
      deviceName: "PI Lab on the test Mac",
      localMachineId: async () => "not-this-machine",
      bundle: () => files,
      log: (message) => logs.push(message),
    })

  const first = connections()
  const added = await first.add({ sshHost: sshd.host, name: "Test Mac" })
  expect(added.state, added.error ?? "").toBe("connected")
  expect(readlinkSync(join(remotePrefix, "current"))).toBe(`versions/${bundle.version}`)
  const { url } = await first.endpoint(added.machineId)
  expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/trpc\?token=/)
  const token = decodeURIComponent(url.split("token=")[1] ?? "")
  const client = connectServer(remoteData, token)
  const hello = await client.client.server.hello.query()
  client.close()
  expect(hello.version).toBe(bundle.version)
  expect(hello.machineId).toBe(added.machineId)
  const serverPid = readServerDiscovery(remoteData)?.pid ?? 0

  // The installed server outlives the app side.
  await first.close()
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  expect(processAlive(serverPid)).toBe(true)

  // Add again after Remove: the installed server is found and used, nothing is installed again.
  const second = connections()
  await second.remove(added.machineId)
  const again = await second.add({ sshHost: sshd.host, name: "Test Mac" })
  expect(again.state, again.error ?? "").toBe("connected")
  expect(readServerDiscovery(remoteData)?.pid).toBe(serverPid)
  await second.close()
  expect(realpathSync(join(remotePrefix, "current"))).toContain(bundle.version)
})
