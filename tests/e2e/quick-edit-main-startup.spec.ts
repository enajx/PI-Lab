import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  test,
} from "./fixtures/playwright"

const mainEntry = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "apps",
  "desktop",
  "out",
  "main",
  "index.js",
)
const desktop = join(dirname(mainEntry), "..", "..")
const electronPath = createRequire(join(desktop, "package.json"))("electron") as string

/** The packaged quick-file entry must leave full-app services outside its static load path. */
test("quick-edit main entry defers full-app dependencies", async () => {
  const entry = await readFile(mainEntry, "utf8")
  const deferredName = entry.match(/require\("\.\/(fullRuntime-[^"]+\.js)"\)/)?.[1]
  expect(deferredName, "full-app chunk must remain loadable").toBeTruthy()
  if (!deferredName) return
  const deferred = await readFile(join(dirname(mainEntry), deferredName), "utf8")
  for (const dependency of ["better-sqlite3", "drizzle-orm", "@trpc/server", "node-pty"]) {
    const reference = `require("${dependency}")`
    expect(entry.includes(reference), `${dependency} must not load before quick edit`).toBe(false)
    expect(deferred.includes(reference), `${dependency} must remain available later`).toBe(true)
  }
})

/** Closing quick edit before background boot finishes must leave the window closed. */
test("quick editor close during background boot does not reopen the full app", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-quick-close-"))
  const file = join(dir, "scratch.py")
  await writeFile(file, "value = 1\n")
  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [mainEntry, file],
      env: {
        ...process.env,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: join(dir, "app-data"),
        PI_LAB_SOCKET_PATH: join(dir, "daemon.sock"),
      },
    })
    const window = await app.firstWindow()
    await expect(window.getByTestId("quick-editor").locator(".cm-content")).toBeFocused()
    await window.evaluate(() => window.close())
    await expect.poll(async () => (await app?.windows())?.length).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(await app.windows()).toHaveLength(0)
  } finally {
    await app?.close()
    await rm(dir, { recursive: true, force: true })
  }
})
