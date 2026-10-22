import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = join(here, "..", "..", "apps", "desktop")
const mainEntry = join(desktopDir, "out", "main", "index.js")
const electronPath = createRequire(join(desktopDir, "package.json"))("electron") as string

let application: ElectronApplication | null = null
let dataDir = ""

async function launch(): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronPath,
    args: [mainEntry],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_TEST_FIRST_RUN: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
    },
  })
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-native-language-"))
  application = await launch()
})

test.afterEach(async () => {
  await application?.close()
  application = null
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("the selected language updates the native menu and survives restart", async () => {
  if (!application) throw new Error("Electron app did not launch")
  const window = await application.firstWindow()
  await expect(window.getByTestId("first-run-setup")).toBeVisible({ timeout: 30_000 })

  const localeRequests: string[] = []
  const network = await window.context().newCDPSession(window)
  await network.send("Network.enable")
  network.on("Network.requestWillBeSent", ({ request }) => {
    if (/\/(?:zh-CN|ko|ja|es|ar|nb)-[^/]+\.js(?:$|\?)/.test(request.url))
      localeRequests.push(request.url)
  })
  await window.getByLabel("Language").selectOption("es")
  await expect(window.getByRole("heading", { name: "Configurar PI Lab" })).toBeVisible()
  expect(localeRequests).toHaveLength(1)
  expect(localeRequests[0]).toMatch(/\/es-/)
  await expect
    .poll(async () =>
      application?.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()?.items.map((item) => item.label),
      ),
    )
    .toContain("Editar")
  expect(await readFile(join(dataDir, "interface-language"), "utf8")).toBe("es")

  await application.close()
  application = await launch()
  await application.firstWindow()
  expect(
    await application.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()?.items.map((item) => item.label),
    ),
  ).toContain("Editar")

  const reopened = await application.firstWindow()
  await expect(reopened.getByRole("heading", { name: "Configurar PI Lab" })).toBeVisible()
  await expect(reopened.locator("html")).toHaveAttribute("lang", "es")
  await reopened.getByLabel("Idioma").selectOption("ar")
  await expect
    .poll(async () =>
      application?.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()?.items.map((item) => item.label),
      ),
    )
    .toContain("تحرير")
})
