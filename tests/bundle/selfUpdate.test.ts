import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { createServer as createTcpServer, type Server as TcpServer } from "node:net"
import { join } from "node:path"
import { afterAll, beforeAll, expect, it } from "vitest"
import { connectServer, processAlive, readServerDiscovery } from "../e2e/fixtures/serverClient"
import {
  type BuiltBundle,
  buildBundle,
  INSTALLER,
  installEnv,
  killProcessesUnder,
  repackBundle,
  runInstall,
  tempDir,
} from "./bundleFixture"

/**
 * Self-update of an installed server (step 1 plan, PR 3, updates B3): v1 is
 * installed by install.sh (`--no-launchd`, temp HOME, prefix and data folder,
 * test mode) and checks a local HTTP server that mimics the GitHub releases
 * API (`PI_LAB_TEST_SERVER_RELEASES_URL`). The feed holds its first answer
 * until the test offers v2, so a terminal can be started first. Success: the
 * server becomes v2 and the terminal session (in the PTY daemon) survives.
 * Failure: v2 runs a fake extra migration, then cannot listen (busy port):
 * install.sh rolls back, v1 answers again on the copied database.
 */

let root: string
let v1: BuiltBundle

beforeAll(async () => {
  root = await tempDir("pi-su-")
  v1 = buildBundle("0.0.1-selfupdate", root)
})

afterAll(async () => {
  killProcessesUnder(root)
  await rm(root, { recursive: true, force: true })
})

/** A fake GitHub releases API: `/releases` (held until {@link offer}) and `/files/<name>`. */
interface Feed {
  url: string
  offer: (bundle: BuiltBundle) => void
  close: () => Promise<void>
}

async function startFeed(): Promise<Feed> {
  let releases: unknown[] | null = null
  const waiting: ServerResponse[] = []
  const files = new Map<string, string>()
  const answer = (response: ServerResponse): void => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify(releases))
  }
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname
    if (path === "/releases") {
      if (releases === null) waiting.push(response)
      else answer(response)
      return
    }
    const file = files.get(path.replace(/^\/files\//, ""))
    if (file === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200)
    response.end(readFileSync(file))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("feed has no port")
  const base = `http://127.0.0.1:${address.port}`
  return {
    url: `${base}/releases`,
    offer: (bundle) => {
      const name = bundle.tarball.split("/").at(-1) ?? ""
      files.set(name, bundle.tarball)
      files.set(`${name}.sha256`, `${bundle.tarball}.sha256`)
      releases = [
        {
          tag_name: `v${bundle.version}`,
          draft: false,
          prerelease: false,
          assets: [name, `${name}.sha256`].map((asset) => ({
            name: asset,
            browser_download_url: `${base}/files/${asset}`,
          })),
        },
      ]
      for (const response of waiting.splice(0)) answer(response)
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** A fresh home, prefix and data folder (short paths: the PTY daemon socket path must stay under 104 bytes), and install.sh arguments and environment using `feed`. */
function setup(name: string, feed: Feed) {
  const dir = join(root, name)
  const home = join(dir, "home")
  const prefix = join(dir, "prefix")
  const dataDir = join(dir, "d")
  mkdirSync(home, { recursive: true })
  const args = [
    "--from-file",
    v1.tarball,
    "--prefix",
    prefix,
    "--data-dir",
    dataDir,
    "--no-launchd",
  ]
  const env = installEnv(home, {
    PI_LAB_TEST_RETAIN_DAEMON: "1",
    PI_LAB_TEST_SERVER_RELEASES_URL: feed.url,
    PI_LAB_TEST_SKILLS_HOME: join(dir, "skills-home"),
  })
  return { dir, prefix, dataDir, args, env }
}

/** Wait until the server in `dataDir` runs build `build` and is alive. */
async function waitForBuild(dataDir: string, build: string, timeoutMs: number): Promise<void> {
  await expect
    .poll(
      () => {
        const discovery = readServerDiscovery(dataDir)
        return discovery !== null && discovery.build === build && processAlive(discovery.pid)
      },
      { timeout: timeoutMs, interval: 500 },
    )
    .toBe(true)
}

it("updates itself from the release feed while a terminal keeps running", async () => {
  const feed = await startFeed()
  const t = setup("ok", feed)
  const v2 = repackBundle(v1, "0.0.2-selfupdate", `${v1.build.slice(0, 15)}2`, t.dir, null)

  const installed = await runInstall(INSTALLER, t.args, t.env)
  expect(installed.code, installed.stderr).toBe(0)

  const before = connectServer(t.dataDir)
  expect((await before.client.server.hello.query()).capabilities).toContain("server-update")
  const term = await before.client.terminal.spawn.mutate({
    command: "/bin/sh",
    args: ["-c", "echo shell-ready; exec /bin/cat"],
    cols: 80,
    rows: 24,
  })
  let output = ""
  const first = before.client.terminal.onData.subscribe(
    { sessionId: term.sessionId },
    { onData: (event) => (output += JSON.stringify(event)) },
  )
  await expect.poll(() => output, { timeout: 10_000 }).toContain("shell-ready")
  first.unsubscribe()
  before.close()

  feed.offer(v2)
  await waitForBuild(t.dataDir, v2.build, 180_000)

  const after = connectServer(t.dataDir)
  expect((await after.client.server.hello.query()).version).toBe(v2.version)
  let later = ""
  const second = after.client.terminal.onData.subscribe(
    { sessionId: term.sessionId },
    { onData: (event) => (later += JSON.stringify(event)) },
  )
  await after.client.terminal.write.mutate({ sessionId: term.sessionId, data: "after-update-é\r" })
  await expect.poll(() => later, { timeout: 10_000 }).toContain("after-update-é")
  second.unsubscribe()
  after.close()
  await feed.close()
})

it("rolls back to v1 and its database copy when v2 does not start", async () => {
  const feed = await startFeed()
  const t = setup("bad", feed)
  const busy: TcpServer = createTcpServer()
  await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve))
  const address = busy.address()
  if (address === null || typeof address === "string") throw new Error("no busy port")
  const v2Build = `${v1.build.slice(0, 15)}f`
  const v2 = repackBundle(v1, "0.0.2-selfupdate", v2Build, t.dir, (bundleRoot) => {
    // A fake extra migration, then a port another process holds.
    const drizzle = join(bundleRoot, "app", "out", "main", "drizzle")
    const journalPath = join(drizzle, "meta", "_journal.json")
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[]
    }
    const last = journal.entries.at(-1)
    if (!last) throw new Error("no migrations in the bundle")
    const tag = `${String(last.idx + 1).padStart(4, "0")}_selfupdate_probe`
    writeFileSync(join(drizzle, `${tag}.sql`), "CREATE TABLE `selfupdate_probe` (`x` integer);\n")
    journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag })
    writeFileSync(journalPath, JSON.stringify(journal, null, 2))
    const launcher = join(bundleRoot, "bin", "pi-lab-server")
    writeFileSync(
      launcher,
      readFileSync(launcher, "utf8").replace(
        /(export PI_LAB_VERSION=\S+\n)/,
        `$1    export PI_LAB_SERVER_PORT=${address.port}\n`,
      ),
    )
    expect(readFileSync(launcher, "utf8")).toContain(`PI_LAB_SERVER_PORT=${address.port}`)
  })

  const installed = await runInstall(INSTALLER, t.args, t.env)
  expect(installed.code, installed.stderr).toBe(0)
  const v1Pid = readServerDiscovery(t.dataDir)?.pid

  feed.offer(v2)
  const failed = join(t.prefix, "failed-versions")
  await expect
    .poll(() => existsSync(failed) && readFileSync(failed, "utf8"), { timeout: 240_000 })
    .toContain(v2.version)
  await waitForBuild(t.dataDir, v1.build, 180_000)
  expect(readServerDiscovery(t.dataDir)?.pid).not.toBe(v1Pid)
  const log = readFileSync(join(t.dataDir, "server-update.log"), "utf8")
  expect(log).toContain("going back to")
  expect(log).toContain("restored the database copied before the migrations")

  // v1 answers on the copied database; the migrated one is kept aside.
  const client = connectServer(t.dataDir)
  const hello = await client.client.server.hello.query()
  expect(hello.version).toBe(v1.version)
  await client.client.settings.get.query()
  client.close()
  const tables = (db: string): string =>
    execFileSync("/usr/bin/sqlite3", [db, "select name from sqlite_master where type='table'"], {
      encoding: "utf8",
    })
  expect(tables(join(t.dataDir, "local.db"))).not.toContain("selfupdate_probe")
  expect(tables(join(t.dataDir, `local.db.failed-${v2Build}`))).toContain("selfupdate_probe")
  // The failed version is not offered again: v1 stays after its own start check.
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  expect(readServerDiscovery(t.dataDir)?.build).toBe(v1.build)
  busy.close()
  await feed.close()
})
