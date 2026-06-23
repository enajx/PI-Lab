import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

/**
 * Whole-app E2E (AGENTS.md §14) for the projects/workspaces feature: launch the
 * real Electron build, open a temp git repo as a project via the `?openProject`
 * seam (so no native dialog is needed), then exercise the full flow —
 *   1. the project shows in the sidebar and opens its route,
 *   2. "Open agent" starts the deterministic test agent (`test-echo`), whose
 *      marker (`AGENT-UI-OK`) reaches the *attached* terminal, with a kind badge
 *      surfacing the §8 policy outcome,
 *   3. the right-sidebar Research panel shows the repo's `RESEARCH.md` (read via
 *      the `files` router from the workspace's working dir),
 *   4. a file written into the repo is reflected by the Changes panel.
 *
 * Driven entirely through the test seams in `mainWindow.ts` (env → renderer query
 * params): `SKIPPER_TEST_OPEN_PROJECT` and `SKIPPER_TEST_AGENT_ID`. No native
 * dialogs, no synthetic keystrokes, no credentials.
 *
 * MUST run under Node (not Bun) — Playwright's `_electron` launcher hangs under
 * Bun (AGENTS.md §13); the repo `e2e` script runs Playwright's CLI through node.
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
  await run(["config", "user.email", "test@skipper.local"])
  await run(["config", "user.name", "Skipper Test"])
  await writeFile(join(dir, "README.md"), "# fixture\n")
  // A RESEARCH.md so the right-sidebar Research panel has content to show.
  await writeFile(join(dir, "RESEARCH.md"), `# ${RESEARCH_HEADING}\n\n${RESEARCH_BODY}\n`)
  await run(["add", "."])
  await run(["commit", "-m", "initial"])
}

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "skipper-e2e-proj-"))
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
      // Open the temp repo as a project on load, and launch the deterministic
      // test agent when "Open agent" is clicked (both via renderer query seams).
      SKIPPER_TEST_OPEN_PROJECT: repoDir,
      SKIPPER_TEST_AGENT_ID: "test-echo",
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

  // Navigate to the project route.
  await projectItem.click()
  await expect(window.getByTestId("project-view")).toBeVisible({ timeout: 30_000 })

  // Launch the agent. With no prior live agent the §8 policy keeps it in the
  // project's main checkout → kind "branch".
  await window.getByTestId("open-agent").click()

  // The session view renders: attached terminal + kind badge + right sidebar.
  await expect(window.getByTestId("session-view")).toBeVisible({ timeout: 30_000 })

  const kindBadge = window.getByTestId("kind-badge")
  await expect(kindBadge).toBeVisible()
  await expect(kindBadge).toHaveAttribute("data-kind", "branch")

  // The agent's marker reaches the ATTACHED terminal — proving sessions.start →
  // attach-mode subscription → xterm all work over the real IPC link.
  const terminal = window.getByTestId("terminal")
  await expect(terminal).toBeVisible()
  await expect(terminal).toContainText(AGENT_MARKER, { timeout: 30_000 })

  // The right sidebar renders with the Research panel active by default. It reads
  // RESEARCH.md from the workspace's working dir (the repo root, since this is a
  // branch workspace) via the `files` router and renders it as markdown.
  await expect(window.getByTestId("right-sidebar")).toBeVisible()
  const research = window.getByTestId("panel-research")
  await expect(research).toBeVisible()
  await expect(research).toContainText(RESEARCH_HEADING, { timeout: 30_000 })
  await expect(research).toContainText(RESEARCH_BODY)

  // Write a new file in the repo so the Changes panel has something to show.
  await writeFile(join(repoDir, "scratch.txt"), "hello from the agent\n")

  // Go back to the project and start a fresh session so its changes query runs
  // after the file was written (the first session's panel was fetched before).
  await window.getByTestId("session-back").click()
  await expect(window.getByTestId("project-view")).toBeVisible()
  await window.getByTestId("open-agent").click()
  await expect(window.getByTestId("session-view")).toBeVisible({ timeout: 30_000 })

  // Switch to the Changes tab; the new file appears as an untracked change.
  await window.getByTestId("panel-tab-changes").click()
  await expect(window.getByTestId("panel-changes")).toBeVisible()
  const change = window.getByTestId("change-item").filter({ hasText: "scratch.txt" })
  await expect(change).toBeVisible({ timeout: 30_000 })
  await expect(change).toHaveAttribute("data-status", "untracked")
})
