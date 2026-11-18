import { type ChildProcess, execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { startHeadlessServer } from "./fixtures/headlessServer"
import { expect, test } from "./fixtures/playwright"
import { connectServer } from "./fixtures/serverClient"
import { stopServerIn } from "./fixtures/stopServer"

/**
 * Server bundle (step 1 plan, PR 3): the packaging script makes
 * `pi-lab-server-<version>-darwin-<arch>.tar.gz` and its `.sha256`. Unpacked
 * outside the repo (so nothing resolves to the repo's node_modules), the
 * bundle's own Node runs the server with a temp data folder in test mode: no
 * Electron in the process tree, the hello answers, a terminal works, and
 * `enroll` prints a device token. Needs the built app (`out/`).
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "..", "apps", "desktop")
const SCRIPT = join(DESKTOP_DIR, "scripts", "package-server-bundle.cjs")
const VERSION = "0.0.0-bundle-test"
const execFileAsync = promisify(execFile)

let rootDir: string
let dataDir: string
let server: ChildProcess | null = null

test.beforeEach(async () => {
  rootDir = await realpath(await mkdtemp(join(tmpdir(), "pi-lab-e2e-bundle-")))
  dataDir = join(rootDir, "data")
  await mkdir(dataDir)
})

test.afterEach(async () => {
  await stopServerIn(dataDir)
  if (server?.exitCode === null) server.kill("SIGKILL")
  server = null
  await rm(rootDir, { recursive: true, force: true })
})

/** Command lines of `pid` and all its descendants. */
async function processTree(pid: number): Promise<string[]> {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,command="])
  const rows = stdout
    .trim()
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
      if (!match) throw new Error(`Unexpected ps line: ${line}`)
      return { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }
    })
  const tree = new Set([pid])
  for (let grew = true; grew; ) {
    grew = false
    for (const row of rows) {
      if (tree.has(row.ppid) && !tree.has(row.pid)) {
        tree.add(row.pid)
        grew = true
      }
    }
  }
  return rows.filter((row) => tree.has(row.pid)).map((row) => row.command)
}

test("the unpacked server bundle runs the server with its own Node, no Electron", async () => {
  test.setTimeout(600_000)
  const { stdout } = await execFileAsync(process.execPath, [SCRIPT, VERSION], {
    maxBuffer: 16 * 1024 * 1024,
  })
  const tarball = stdout.trim().split("\n").at(-1) ?? ""
  expect(tarball).toMatch(new RegExp(`pi-lab-server-${VERSION}-darwin-${process.arch}\\.tar\\.gz$`))
  const sum = createHash("sha256").update(readFileSync(tarball)).digest("hex")
  expect((await readFile(`${tarball}.sha256`, "utf8")).split(/\s+/)[0]).toBe(sum)

  const unpackDir = join(rootDir, "unpacked")
  await mkdir(unpackDir)
  await execFileAsync("/usr/bin/tar", ["-xzf", tarball, "-C", unpackDir])
  const bundleDir = join(unpackDir, `pi-lab-server-${VERSION}-darwin-${process.arch}`)
  const launcher = join(bundleDir, "bin", "pi-lab-server")
  const spawnHelper = join(bundleDir, "app", "node_modules", "node-pty", "build", "Release")
  expect(statSync(join(spawnHelper, "spawn-helper")).mode & 0o111).toBe(0o111)

  const env = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME,
    SHELL: "/bin/zsh",
    PI_LAB_TEST_MODE: "1",
    PI_LAB_DATA_DIR: dataDir,
  }
  server = await startHeadlessServer(launcher, ["serve"], env, dataDir)
  const client = connectServer(dataDir)
  const hello = await client.client.server.hello.query()
  expect(hello.version).toBe(VERSION)
  expect(hello.capabilities).toContain("machines")

  // A terminal: spawn a shell, type a line, read it back.
  const term = await client.client.terminal.spawn.mutate({
    command: "/bin/sh",
    args: ["-c", "echo shell-ready; exec /bin/cat"],
    cols: 80,
    rows: 24,
  })
  let output = ""
  const subscription = client.client.terminal.onData.subscribe(
    { sessionId: term.sessionId },
    { onData: (event) => (output += JSON.stringify(event)) },
  )
  await expect.poll(() => output, { timeout: 10_000 }).toContain("shell-ready")
  await client.client.terminal.write.mutate({ sessionId: term.sessionId, data: "bundle-é🙂\r" })
  await expect.poll(() => output, { timeout: 10_000 }).toContain("bundle-é🙂")
  subscription.unsubscribe()

  const tree = await processTree(hello.pid)
  const bundleNode = join(bundleDir, "node", "bin", "node")
  expect(tree.some((command) => command.startsWith(`${bundleNode} `))).toBe(true)
  expect(tree.some((command) => command.includes("pty-daemon"))).toBe(true)
  expect(tree.filter((command) => /electron/i.test(command))).toEqual([])

  const enrolled = await execFileAsync(launcher, ["enroll", "--name", "Bundle test"], { env })
  const device = JSON.parse(enrolled.stdout) as { machineId: string; token: string }
  expect(device.machineId).toBe(hello.machineId)
  client.close()
})
