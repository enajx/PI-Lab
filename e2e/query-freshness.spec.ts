import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

test("Git capability probes are cached on a quick Dashboard return and refresh after external init", async () => {
  test.setTimeout(75_000)
  const dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-freshness-"))
  const folderDir = join(dataDir, "plain-folder")
  const binDir = join(dataDir, "bin")
  const gitLog = join(dataDir, "git.log")
  const gitPath = (await execFileAsync("which", ["git"])).stdout.trim()
  let app: ElectronApplication | null = null

  try {
    await mkdir(folderDir)
    await mkdir(binDir)
    await writeFile(join(folderDir, "README.md"), "# Plain folder\n")
    await writeFile(
      join(binDir, "git"),
      `#!/bin/sh\nprintf '%s\\t' "$@" >> '${gitLog}'\nprintf '\\n' >> '${gitLog}'\nexec '${gitPath}' "$@"\n`,
    )
    await chmod(join(binDir, "git"), 0o755)

    app = await electron.launch({
      executablePath: ELECTRON_PATH,
      args: [MAIN_ENTRY],
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        PI_LAB_TEST_MODE: "1",
        PI_LAB_DATA_DIR: dataDir,
        PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
        PI_LAB_TEST_OPEN_PROJECT: folderDir,
      },
    })
    const window = await app.firstWindow()
    const probeCount = async () =>
      (await readFile(gitLog, "utf8"))
        .split("\n")
        .filter(
          (line) => line.includes(folderDir) && line.includes("rev-parse\t--is-inside-work-tree"),
        ).length

    await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
    await expect(window.getByTestId("project-card-auto-research")).toBeDisabled()
    await expect.poll(probeCount).toBeGreaterThan(0)

    await window.getByTestId("project-item").click()
    await expect(window.getByTestId("non-git-project-notice")).toBeVisible()
    const projectProbes = await probeCount()
    await window.getByTestId("nav-project-dashboard").click()
    await expect(window.getByTestId("dashboard")).toBeVisible()
    expect(await probeCount()).toBe(projectProbes)

    // The folder can become a repository outside PI Lab. The cached capability
    // expires after 30 seconds and the next mount must run the actual git probe.
    await execFileAsync(gitPath, ["init", "-b", "main", folderDir])
    await new Promise((resolve) => setTimeout(resolve, 31_000))
    await window.getByTestId("project-item").click()
    await expect(window.getByTestId("non-git-project-notice")).toBeHidden({ timeout: 10_000 })
    await expect.poll(probeCount).toBeGreaterThan(projectProbes)
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
