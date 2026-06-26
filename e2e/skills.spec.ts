import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

/**
 * Whole-app E2E (docs/testing-and-build.md, P8b): launch the real Electron build, open a
 * temp git repo as a project via the `?openProject` seam (no native dialog),
 * navigate to the Skills science tab, and prove the read-only catalog is wired
 * end to end — a `SKILL.md` written into the repo's `.agents/skills` appears as a
 * card with its frontmatter name and source badge.
 *
 * MUST run under Node (not Bun) — Playwright's `_electron` launcher hangs under
 * Bun (docs/testing-and-build.md (build & ship)); the repo `e2e` script runs Playwright's CLI through node.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

const execFileAsync = promisify(execFile)

const SKILL_NAME = "photon-pipeline"
const SKILL_DESCRIPTION = "Reduce raw photon-counter frames."

let app: ElectronApplication
let dataDir: string
let repoDir: string

/** Initialize a throwaway git repo with one commit and a skill on `main`. */
async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", dir])
  const run = (args: string[]) => execFileAsync("git", ["-C", dir, ...args])
  await run(["config", "user.email", "test@skipper.local"])
  await run(["config", "user.name", "Skipper Test"])
  await writeFile(join(dir, "README.md"), "# fixture\n")

  // A skill the catalog should discover: `.agents/skills/<slug>/SKILL.md`.
  const skillDir = join(dir, ".agents", "skills", SKILL_NAME)
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${SKILL_NAME}\ndescription: ${SKILL_DESCRIPTION}\n---\n\n# ${SKILL_NAME}\n`,
  )

  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "skipper-e2e-skills-"))
  repoDir = join(dataDir, "repo")
  await initRepo(repoDir)

  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      SKIPPER_TEST_MODE: "1",
      SKIPPER_DATA_DIR: dataDir,
      SKIPPER_SOCKET_PATH: join(dataDir, "daemon.sock"),
      // Open the temp repo as a project on load (renderer query seam).
      SKIPPER_TEST_OPEN_PROJECT: repoDir,
    },
  })
})

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("skills tab lists a SKILL.md discovered in the opened project", async () => {
  const window = await app.firstWindow()

  // Boot gate.
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  // The `?openProject` seam opens the repo; it shows in the sidebar.
  await expect(window.getByTestId("project-item")).toBeVisible({ timeout: 30_000 })

  // Navigate to the Skills science tab via the sidebar nav.
  const skillsNav = window.locator('[data-testid="science-nav-item"][data-science-tab="skills"]')
  await expect(skillsNav).toBeVisible({ timeout: 30_000 })
  await skillsNav.click()

  // The tab renders, defaulting to the just-opened project.
  await expect(window.getByTestId("science-skills")).toBeVisible({ timeout: 30_000 })

  // The repo's skill appears as a card with its frontmatter name.
  const card = window.locator(`[data-testid="skill-card"][data-skill="${SKILL_NAME}"]`)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card.getByTestId("skill-name")).toHaveText(SKILL_NAME)
  await expect(card.getByTestId("skill-source")).toHaveText(".agents/skills")

  // ⌘F on the Skills tab opens a context finder over the SKILLS here (not the project finder),
  // proving the shell defers ⌘F to the science tab.
  await window.keyboard.press("ControlOrMeta+f")
  await expect(window.getByTestId("quick-find")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("quick-find-item").first()).toContainText(SKILL_NAME)
})
