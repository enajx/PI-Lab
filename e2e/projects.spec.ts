import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

/**
 * Whole-app E2E (md/engineering/testing-and-build.md) for the projects/workspaces feature: launch the
 * real Electron build, open a temp git repo as a project via the `?openProject`
 * seam (so no native dialog is needed), then exercise the full flow —
 *   1. the project shows in the sidebar and opens DIRECTLY into the rich project
 *      view (right sidebar + central launcher — no intermediate "open agent" page),
 *   2. the right-sidebar Research panel shows the repo's `RESEARCH.md` (read via
 *      the `files` router from the project's main checkout),
 *   3. the central "Open agent" launcher starts the deterministic test agent
 *      (`test-echo`), whose marker (`AGENT-UI-OK`) reaches the *attached* terminal,
 *      with a kind badge on the agent tab surfacing the policy outcome,
 *   4. revealing the (default-hidden) Code changes panel via its gear reflects a
 *      file written into the repo.
 *
 * Driven entirely through the test seams in `mainWindow.ts` (env → renderer query
 * params): `PI_LAB_TEST_OPEN_PROJECT` and `PI_LAB_TEST_AGENT_ID`. No native
 * dialogs, no synthetic keystrokes, no credentials.
 *
 * MUST run under Node (not Bun) — Playwright's `_electron` launcher hangs under
 * Bun (md/engineering/testing-and-build.md (build & ship)); the repo `e2e` script runs Playwright's CLI through node.
 */

const AGENT_MARKER = "AGENT-UI-OK"
const RESEARCH_HEADING = "Photon Drift Study"
const RESEARCH_BODY = "The drift was statistically significant."
const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = join(HERE, "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const ELECTRON_PATH = createRequire(join(DESKTOP_DIR, "package.json"))("electron") as string

const execFileAsync = promisify(execFile)

let app: ElectronApplication
let dataDir: string
let repoDir: string

/** Initialize a throwaway git repo with one commit on `main`. */
async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", dir])
  const run = (args: string[]) => execFileAsync("git", ["-C", dir, ...args])
  await run(["config", "user.email", "test@pi-lab.local"])
  await run(["config", "user.name", "PI Lab Test"])
  await writeFile(join(dir, "README.md"), "# fixture\n")
  // A RESEARCH.md so the right-sidebar Research panel has content to show.
  await writeFile(join(dir, "RESEARCH.md"), `# ${RESEARCH_HEADING}\n\n${RESEARCH_BODY}\n`)
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-proj-"))
  repoDir = join(dataDir, "repo")
  await initRepo(repoDir)

  app = await electron.launch({
    executablePath: ELECTRON_PATH,
    args: [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      // Open the temp repo as a project on load, and launch the deterministic
      // test agent when "Open agent" is clicked (both via renderer query seams).
      PI_LAB_TEST_OPEN_PROJECT: repoDir,
      PI_LAB_TEST_AGENT_ID: "test-echo",
    },
  })
})

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("open a project, launch an agent, and see its changes", async () => {
  const window = await app.firstWindow()

  // Boot gate.
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })

  // The `?openProject` seam opens the repo; it shows up in the sidebar as a
  // single project item (repo folder name is "repo").
  const projectItem = window.getByTestId("project-item")
  await expect(projectItem).toBeVisible({ timeout: 30_000 })
  await expect(projectItem).toContainText("repo")

  // Clicking the project lands DIRECTLY on the rich project view — no intermediate
  // "open agent" page. The right sidebar and the central launcher are both visible.
  await projectItem.click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("right-sidebar")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("central-launcher")).toBeVisible({ timeout: 30_000 })

  // The standalone add control sits immediately before the direct robot
  // launcher and exposes the three peer pane types.
  await expect(
    window.locator('[data-testid="central-add-menu"], [data-testid="central-new-agent"]'),
  ).toHaveCount(2)
  expect(
    await window
      .locator('[data-testid="central-add-menu"], [data-testid="central-new-agent"]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid"))),
  ).toEqual(["central-add-menu", "central-new-agent"])
  await window.getByTestId("central-add-menu").click()
  await expect(window.getByTestId("central-add-agent")).toHaveText("Agent CLI")
  await expect(window.getByTestId("central-add-terminal")).toHaveText("Terminal")
  await expect(window.getByTestId("central-add-document")).toHaveText("Document")
  await window.getByTestId("central-add-menu").click()

  // Project panels explain their purpose in the app-wide hover-help panel.
  await window.getByTestId("panel-tab-todos").hover()
  await expect(window.getByTestId("sidebar-feature-help-label")).toHaveText("TODOs")
  await expect(window.getByTestId("sidebar-feature-help-description")).toHaveText(
    "View the project's selected task Markdown file.",
  )

  // The Research panel (the default right-sidebar tab) reads RESEARCH.md from the
  // project's main checkout via the `files` router and renders it as markdown.
  const research = window.getByTestId("panel-research")
  await expect(research).toBeVisible()
  await expect(research).toContainText(RESEARCH_HEADING, { timeout: 30_000 })
  await expect(research).toContainText(RESEARCH_BODY)

  // The first launch opens the New session chooser, with Agent + Terminal as
  // peer modes and Chat deliberately present but unavailable. The test override
  // preselects the deterministic harness without bypassing this first-use UX.
  await window.getByTestId("launcher-agent").click()
  const newSession = window.getByTestId("new-agent-dialog")
  await expect(newSession).toBeVisible()
  await expect(newSession.getByRole("button", { name: "Chat" })).toBeDisabled()
  await expect(newSession.getByLabel("Test Echo")).toBeChecked()
  await newSession.getByRole("button", { name: "Start agent" }).click()

  // With no prior live agent the session policy keeps it in the main checkout →
  // kind "branch", surfaced on the agent tab. (The same badge also appears in the
  // session list, so scope to the central tab's badge to stay unambiguous.)
  const kindBadge = window.getByTestId("central-tab").getByTestId("kind-badge")
  await expect(kindBadge).toBeVisible({ timeout: 30_000 })
  await expect(kindBadge).toHaveAttribute("data-kind", "branch")

  // The agent's marker reaches the ATTACHED terminal — proving sessions.start →
  // attach-mode subscription → xterm all work over the real IPC link.
  const terminal = window.getByTestId("terminal")
  await expect(terminal).toBeVisible()
  await expect(terminal).toContainText(AGENT_MARKER, { timeout: 30_000 })

  // The Code changes panel is hidden by default — reveal it via the View-options
  // menu (gear → toggle "Code changes"), close the menu, then open its tab and
  // write a file the polling panel will pick up as untracked.
  await window.getByTestId("right-sidebar-settings").click()
  await window.getByTestId("right-sidebar-toggle-changes").click()
  await window.keyboard.press("Escape")
  await window.getByTestId("panel-tab-changes").click()
  await expect(window.getByTestId("panel-changes")).toBeVisible()

  await writeFile(join(repoDir, "scratch.txt"), "hello from the agent\n")

  const change = window.getByTestId("change-item").filter({ hasText: "scratch.txt" })
  await expect(change).toBeVisible({ timeout: 30_000 })
  await expect(change).toHaveAttribute("data-status", "untracked")
})
