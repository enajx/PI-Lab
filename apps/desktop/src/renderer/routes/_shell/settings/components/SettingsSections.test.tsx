import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, test } from "vitest"
import { AppProviders } from "../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../test/fakeTrpcClient"
import {
  AgentsSection,
  AppearanceSection,
  CaffeineSection,
  EditorSection,
  GeneralSection,
  NotificationsSection,
  ProjectViewSection,
  SectionsSection,
  ShortcutsSection,
} from "./SettingsSections"

/**
 * Component tests for the Settings sections (plan "Settings panel, project-view
 * rework"): the theme picker drives the existing ThemeProvider, renderer-only
 * prefs persist to localStorage, and DB-backed editor settings round-trip through
 * the `settings` router (faked over an in-memory link).
 */

function renderSection(node: React.ReactNode, handlers: FakeHandlers = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient({
    "system.fonts": () => ({ families: [], error: null }),
    ...handlers,
  })
  render(
    <AppProviders client={client} queryClient={queryClient}>
      {node}
    </AppProviders>,
  )
}

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.classList.remove("dark")
})

describe("Settings sections", () => {
  test("changes interface language and switches document direction for Arabic", () => {
    renderSection(<GeneralSection />)
    const language = screen.getByTestId<HTMLSelectElement>("settings-interface-language")
    fireEvent.change(language, { target: { value: "ar" } })
    expect(window.localStorage.getItem("pi-lab.interface.language")).toBe("ar")
    expect(document.documentElement.lang).toBe("ar")
    expect(document.documentElement.dir).toBe("rtl")
    expect(screen.getByText("السلوك العام للتطبيق.")).toBeTruthy()
  })

  test("Shortcuts rejects a conflicting chord, preserves the prior binding, and stays ready to retry", async () => {
    renderSection(<ShortcutsSection />)

    expect(screen.getByTestId("shortcut-command-palette").textContent).toBe("⌘P")
    expect(screen.getByTestId("shortcut-quick-open").textContent).toBe("⌘F")

    fireEvent.click(screen.getByTestId("shortcut-command-palette-rebind"))
    fireEvent.keyDown(window, { key: "f", metaKey: true })

    const conflict = await screen.findByRole("alert")
    expect(conflict.textContent).toContain("⌘F")
    expect(conflict.textContent).toContain("Quick open file")
    expect(screen.getByTestId("shortcut-command-palette").textContent).toBe("Press keys…")
    expect(window.localStorage.getItem("pi-lab.shortcuts")).not.toContain(
      '"command-palette":"Mod+f"',
    )

    fireEvent.keyDown(window, { key: "k", metaKey: true })
    await waitFor(() =>
      expect(screen.getByTestId("shortcut-command-palette").textContent).toBe("⌘K"),
    )
    expect(screen.queryByRole("alert")).toBeNull()

    fireEvent.click(screen.getByTestId("shortcut-command-palette-rebind"))
    fireEvent.keyDown(window, { key: "f", metaKey: true })
    expect(await screen.findByRole("alert")).toBeTruthy()
    fireEvent.click(screen.getByTestId("shortcut-command-palette-rebind"))

    expect(screen.getByTestId("shortcut-command-palette").textContent).toBe("⌘K")
    expect(screen.queryByRole("alert")).toBeNull()
  })

  test("Shortcuts refuses a reset when another action uses the default chord", async () => {
    renderSection(<ShortcutsSection />)

    fireEvent.click(screen.getByTestId("shortcut-command-palette-rebind"))
    fireEvent.keyDown(window, { key: "k", metaKey: true })
    fireEvent.click(screen.getByTestId("shortcut-quick-open-rebind"))
    fireEvent.keyDown(window, { key: "p", metaKey: true })

    expect(screen.getByTestId("shortcut-command-palette").textContent).toBe("⌘K")
    expect(screen.getByTestId("shortcut-quick-open").textContent).toBe("⌘P")

    fireEvent.click(screen.getByTestId("shortcut-command-palette-reset"))

    const conflict = await screen.findByRole("alert")
    expect(conflict.textContent).toContain("⌘P")
    expect(conflict.textContent).toContain("Quick open file")
    expect(screen.getByTestId("shortcut-command-palette").textContent).toBe("Press keys…")

    fireEvent.click(screen.getByTestId("shortcut-command-palette-rebind"))
    expect(screen.getByTestId("shortcut-command-palette").textContent).toBe("⌘K")
  })

  test("Appearance mode picker toggles the .dark class", async () => {
    renderSection(<AppearanceSection />)
    // ThemeProvider defaults to light and applies it on mount (no .dark).
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(false))

    fireEvent.change(screen.getByTestId("settings-theme-mode"), { target: { value: "dark" } })
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true))
  })

  test("Appearance gallery selects and applies a named app theme", async () => {
    renderSection(<AppearanceSection />)
    expect(screen.getByTestId("settings-app-themes").querySelectorAll("button")).toHaveLength(9)
    expect(screen.getByRole("button", { name: "Default" }).getAttribute("aria-pressed")).toBe(
      "true",
    )

    fireEvent.click(screen.getByRole("button", { name: "Tokyo Night" }))
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--background")).toBe("#e1e2e7"),
    )
    expect(screen.getByRole("button", { name: "Tokyo Night" }).getAttribute("aria-pressed")).toBe(
      "true",
    )
    expect(window.localStorage.getItem("pi-lab.appTheme")).toBe("tokyo-night")
  })

  test("Appearance does not expose a Caffeine animation choice", async () => {
    renderSection(<AppearanceSection />)

    expect(screen.queryByTestId("settings-caffeine-animation")).toBeNull()
  })

  test("Appearance Advanced persists bounded global editor typography and resets it", async () => {
    renderSection(<AppearanceSection />, {
      "system.fonts": () => ({
        families: ["Avenir Next", "Menlo"],
        error: null,
      }),
    })

    const family = await screen.findByTestId<HTMLSelectElement>("settings-editor-font-family")
    expect(family.textContent).toContain("System monospace (default)")
    await waitFor(() => expect(family.textContent).toContain("Avenir Next"))

    fireEvent.change(family, { target: { value: "Avenir Next" } })
    const size = screen.getByTestId<HTMLInputElement>("settings-editor-font-size")
    fireEvent.change(size, { target: { value: "999" } })

    expect(window.localStorage.getItem("pi-lab.editor.fontFamily")).toBe("Avenir Next")
    expect(window.localStorage.getItem("pi-lab.editor.fontSize")).toBe("24")

    fireEvent.click(screen.getByTestId("settings-editor-font-reset"))
    expect(family.value).toBe("default")
    expect(size.value).toBe("14")
  })

  test("Appearance Advanced keeps the safe default visible when font detection fails", async () => {
    renderSection(<AppearanceSection />, {
      "system.fonts": () => ({
        families: [],
        error: "System fonts could not be detected. The default monospace font is still available.",
      }),
    })

    expect((await screen.findByTestId("settings-editor-font-error")).textContent).toContain(
      "default monospace font",
    )
    expect(
      screen.getByRole<HTMLSelectElement>("combobox", { name: "Editor font family" }).value,
    ).toBe("default")
  })

  test("Appearance Advanced persists global Digital Rain density and speed", async () => {
    renderSection(<AppearanceSection />)

    const density = await screen.findByTestId<HTMLSelectElement>("settings-digital-rain-density")
    const speed = screen.getByTestId<HTMLSelectElement>("settings-digital-rain-speed")
    expect(density.value).toBe("normal")
    expect(speed.value).toBe("normal")

    fireEvent.change(density, { target: { value: "dense" } })
    fireEvent.change(speed, { target: { value: "slow" } })

    expect(window.localStorage.getItem("pi-lab.digitalRain.density")).toBe("dense")
    expect(window.localStorage.getItem("pi-lab.digitalRain.speed")).toBe("slow")
  })

  test("General section round-trips confirm-on-quit through settings.updateGeneral", async () => {
    const patches: unknown[] = []
    renderSection(<GeneralSection />, {
      "settings.get": () => ({ confirmOnQuit: true, worktreePerAgent: false }),
      "settings.updateGeneral": (input) => {
        patches.push(input)
        return { confirmOnQuit: false, worktreePerAgent: false }
      },
    })
    await waitFor(() => expect(screen.getByTestId("settings-confirm-quit")).toBeTruthy())
    expect(screen.getByTestId("settings-run-setup").textContent).toBe("Run setup again")
    fireEvent.click(screen.getByTestId("settings-confirm-quit"))
    await waitFor(() => expect(patches).toContainEqual({ confirmOnQuit: false }))
  })

  test("General toggles background operation and OS login separately", async () => {
    const generalPatches: unknown[] = []
    const loginPatches: unknown[] = []
    renderSection(<GeneralSection />, {
      "settings.get": () => ({
        confirmOnQuit: true,
        worktreePerAgent: false,
        keepRunningAfterClose: true,
      }),
      "settings.updateGeneral": (input) => {
        generalPatches.push(input)
        return input
      },
      "system.startAtLogin": () => ({ enabled: false }),
      "system.setStartAtLogin": (input) => {
        loginPatches.push(input)
        return input
      },
    })
    const background = await screen.findByTestId("settings-keep-running-after-close")
    const login = await screen.findByTestId("settings-start-at-login")
    expect(background.getAttribute("aria-checked")).toBe("true")
    expect(login.getAttribute("aria-checked")).toBe("false")
    fireEvent.click(background)
    fireEvent.click(login)
    await waitFor(() => {
      expect(generalPatches).toContainEqual({ keepRunningAfterClose: false })
      expect(loginPatches).toContainEqual({ enabled: true })
    })
  })

  test("General lets the user select the public update channel", async () => {
    const patches: unknown[] = []
    renderSection(<GeneralSection />, {
      "settings.get": () => ({ publicUpdateChannel: "stable" }),
      "settings.updateGeneral": (input) => {
        patches.push(input)
        return { publicUpdateChannel: "beta" }
      },
    })
    const channel = await screen.findByTestId<HTMLSelectElement>("settings-update-channel")
    expect(channel.value).toBe("stable")
    expect(Array.from(channel.options, (option) => option.textContent)).toEqual(["Stable", "Beta"])
    fireEvent.change(channel, { target: { value: "beta" } })
    await waitFor(() => expect(patches).toContainEqual({ publicUpdateChannel: "beta" }))
  })

  test("General restores project tabs by default and lets the user turn restoration off", async () => {
    renderSection(<GeneralSection />, {
      "settings.get": () => ({ confirmOnQuit: true, worktreePerAgent: false }),
    })

    const toggle = await screen.findByTestId("settings-restore-project-tabs")
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    expect(window.localStorage.getItem("pi-lab.projectView.restoreTabs")).toBe("false")
  })

  test("Agents section persists config storage and executable overrides", async () => {
    const updates: unknown[] = []
    renderSection(<AgentsSection />, {
      "agents.list": () => [
        {
          id: "claude-code",
          label: "Claude Code",
          available: true,
          executable: "/usr/local/bin/claude",
        },
        { id: "codex", label: "Codex", available: false, executable: "codex" },
      ],
      "settings.get": () => ({
        worktreePerAgent: false,
        agents: { projectConfigStorage: "app", executableOverrides: {} },
      }),
      "settings.updateAgents": (input) => {
        updates.push(input)
        return input
      },
    })

    fireEvent.change(await screen.findByTestId("settings-project-config-storage"), {
      target: { value: "both" },
    })
    const input = await screen.findByTestId("settings-agent-executable-claude-code")
    fireEvent.change(input, { target: { value: "/opt/bin/claude" } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(updates).toContainEqual({ projectConfigStorage: "both" })
      expect(updates).toContainEqual({
        executableOverrides: { "claude-code": "/opt/bin/claude" },
      })
    })
    expect(screen.getByText("Not found: codex")).toBeTruthy()
  })

  test("Agents section surfaces config persistence failures", async () => {
    renderSection(<AgentsSection />, {
      "agents.list": () => [],
      "settings.get": () => ({
        worktreePerAgent: false,
        agents: {
          projectConfigStorage: "app",
          executableOverrides: {},
          setupCompleted: false,
        },
      }),
      "settings.updateAgents": () => {
        throw new Error("Could not save agent settings")
      },
    })

    fireEvent.change(await screen.findByTestId("settings-project-config-storage"), {
      target: { value: "project" },
    })
    expect((await screen.findByTestId("settings-agents-error")).textContent).toContain(
      "Could not save agent settings",
    )
  })

  test("Notifications section shows the persisted defaults with accessible controls", async () => {
    renderSection(<NotificationsSection />, {
      "settings.get": () => ({
        notifications: {
          muted: false,
          agentInput: { enabled: true, sound: "chime" },
          agentTurnCompletion: { enabled: true, sound: "success" },
          terminalCompletion: { enabled: true, sound: "success" },
          workflowStart: { enabled: false, sound: "pulse" },
          workflowCompletion: { enabled: true, sound: "success" },
          workflowFailure: { enabled: true, sound: "alert" },
        },
      }),
    })

    expect(
      (await screen.findByRole("switch", { name: "Mute all notifications" })).getAttribute(
        "aria-checked",
      ),
    ).toBe("false")
    expect(
      screen
        .getByRole("switch", { name: "Agent needs input notifications" })
        .getAttribute("aria-checked"),
    ).toBe("true")
    expect(
      screen
        .getByRole("switch", { name: "Agent finished its turn notifications" })
        .getAttribute("aria-checked"),
    ).toBe("true")
    expect(
      screen
        .getByRole("switch", { name: "Terminal command finished notifications" })
        .getAttribute("aria-checked"),
    ).toBe("true")
    expect(
      screen
        .getByRole("switch", { name: "Workflow started notifications" })
        .getAttribute("aria-checked"),
    ).toBe("false")
    expect(
      (screen.getByRole("combobox", { name: "Workflow failed sound" }) as HTMLSelectElement).value,
    ).toBe("alert")
    expect(screen.getByRole("button", { name: "Preview Workflow failed sound" })).toBeTruthy()
  })

  test("Notifications section sends only changed event fields and mute state", async () => {
    const updates: unknown[] = []
    const notifications = {
      muted: false,
      agentInput: { enabled: true, sound: "chime" },
      agentTurnCompletion: { enabled: true, sound: "success" },
      terminalCompletion: { enabled: true, sound: "success" },
      workflowStart: { enabled: false, sound: "pulse" },
      workflowCompletion: { enabled: true, sound: "success" },
      workflowFailure: { enabled: true, sound: "alert" },
    }
    renderSection(<NotificationsSection />, {
      "settings.get": () => ({ notifications }),
      "settings.updateNotifications": (input) => {
        updates.push(input)
        return input
      },
    })

    fireEvent.click(await screen.findByRole("switch", { name: "Workflow started notifications" }))
    await waitFor(() =>
      expect(updates).toContainEqual({
        workflowStart: { enabled: true },
      }),
    )

    fireEvent.click(screen.getByRole("switch", { name: "Agent finished its turn notifications" }))
    await waitFor(() =>
      expect(updates).toContainEqual({
        agentTurnCompletion: { enabled: false },
      }),
    )

    fireEvent.change(screen.getByRole("combobox", { name: "Agent needs input sound" }), {
      target: { value: "silent" },
    })
    await waitFor(() =>
      expect(updates).toContainEqual({
        agentInput: { sound: "silent" },
      }),
    )
    fireEvent.click(screen.getByRole("switch", { name: "Mute all notifications" }))
    await waitFor(() => expect(updates).toContainEqual({ muted: true }))
  })

  test("Silent sound preview reports its explicit no-audio outcome", async () => {
    renderSection(<NotificationsSection />, {
      "settings.get": () => ({
        notifications: {
          muted: false,
          agentInput: { enabled: true, sound: "silent" },
          agentTurnCompletion: { enabled: true, sound: "success" },
          terminalCompletion: { enabled: true, sound: "success" },
          workflowStart: { enabled: false, sound: "pulse" },
          workflowCompletion: { enabled: true, sound: "success" },
          workflowFailure: { enabled: true, sound: "alert" },
        },
      }),
    })

    await waitFor(() =>
      expect(
        (screen.getByRole("combobox", { name: "Agent needs input sound" }) as HTMLSelectElement)
          .value,
      ).toBe("silent"),
    )
    fireEvent.click(screen.getByRole("button", { name: "Preview Agent needs input sound" }))
    await waitFor(() =>
      expect(screen.getByTestId("notification-preview-status").textContent).toBe(
        "Agent needs input is set to Silent.",
      ),
    )
  })

  test("Caffeine section restores mode and scope and reports the live blocker state", async () => {
    renderSection(<CaffeineSection />, {
      "caffeine.status": () => ({
        mode: "auto",
        scope: "system-plus-display",
        held: true,
      }),
    })

    const mode = await screen.findByTestId<HTMLSelectElement>("settings-caffeine-mode")
    await waitFor(() => expect(mode.value).toBe("auto"))
    expect(screen.getByText("Prevent the computer from sleeping.")).toBeTruthy()
    expect(screen.getByTestId<HTMLSelectElement>("settings-caffeine-scope").value).toBe(
      "system-plus-display",
    )
    expect(screen.getByTestId("settings-caffeine-status").textContent).toContain("active")
    expect(screen.getByTestId("settings-caffeine-status").getAttribute("data-held")).toBe("true")
  })

  test("Caffeine Settings controls apply mode and scope through the controller", async () => {
    const modeUpdates: unknown[] = []
    const scopeUpdates: unknown[] = []
    let status: {
      mode: "off" | "auto"
      scope: "system-only" | "system-plus-display"
      held: boolean
    } = {
      mode: "off",
      scope: "system-only",
      held: false,
    }
    renderSection(<CaffeineSection />, {
      "caffeine.status": () => status,
      "caffeine.setMode": (input) => {
        modeUpdates.push(input)
        status = { ...status, mode: "auto" }
        return status
      },
      "caffeine.setScope": (input) => {
        scopeUpdates.push(input)
        status = { ...status, scope: "system-plus-display" }
        return status
      },
    })

    fireEvent.change(await screen.findByTestId("settings-caffeine-mode"), {
      target: { value: "auto" },
    })
    await waitFor(() => expect(modeUpdates).toContainEqual({ mode: "auto" }))

    fireEvent.change(screen.getByTestId("settings-caffeine-scope"), {
      target: { value: "system-plus-display" },
    })
    await waitFor(() => expect(scopeUpdates).toContainEqual({ scope: "system-plus-display" }))
  })

  test('Project view toggle persists "show code changes"', () => {
    renderSection(<ProjectViewSection />)
    fireEvent.click(screen.getByTestId("settings-show-code-changes"))
    expect(window.localStorage.getItem("pi-lab.projectView.showCodeChanges")).toBe("true")
  })

  test('Project view toggle persists "show skills"', () => {
    renderSection(<ProjectViewSection />)
    fireEvent.click(screen.getByTestId("settings-show-skills"))
    expect(window.localStorage.getItem("pi-lab.projectView.showSkillsPanel")).toBe("true")
  })

  test("Project view selects the main Markdown file for the chosen project", async () => {
    const selected: unknown[] = []
    renderSection(<ProjectViewSection />, {
      "projects.list": () => [
        { id: "p1", name: "Alpha", mainRelPath: null },
        { id: "p2", name: "Beta", mainRelPath: "RESEARCH.md" },
      ],
      "projects.setDocumentPath": (input) => {
        selected.push(input)
      },
    })

    await screen.findByRole("option", { name: "Beta" })
    fireEvent.change(screen.getByTestId("settings-main-project"), { target: { value: "p2" } })
    expect(screen.getByText("Main readme: RESEARCH.md")).toBeTruthy()
    fireEvent.change(screen.getByRole("textbox", { name: "Main Markdown path" }), {
      target: { value: "notes/Overview.md" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Select" }))

    await waitFor(() =>
      expect(selected).toEqual([{ id: "p2", kind: "main", relPath: "notes/Overview.md" }]),
    )
  })

  test("Project view changes the chosen project's type", async () => {
    const selected: unknown[] = []
    renderSection(<ProjectViewSection />, {
      "projects.list": () => [{ id: "p1", name: "Alpha", typeId: null, mainRelPath: null }],
      "settings.get": () => ({
        projectTemplate: {
          projectTypes: [
            { id: "research", name: "Research project", guidance: "" },
            { id: "software", name: "Software project", guidance: "" },
            { id: "paper", name: "Paper", guidance: "" },
          ],
        },
      }),
      "projects.setType": (input) => {
        selected.push(input)
      },
    })

    expect(((await screen.findByTestId("settings-project-type")) as HTMLSelectElement).value).toBe(
      "",
    )
    await screen.findByRole("option", { name: "Paper" })
    fireEvent.change(screen.getByTestId("settings-project-type"), {
      target: { value: "paper" },
    })
    await waitFor(() => expect(selected).toEqual([{ id: "p1", typeId: "paper" }]))
  })

  test("Project view translates its project controls and built-in type names", async () => {
    window.localStorage.setItem("pi-lab.interface.language", "es")
    renderSection(<ProjectViewSection />, {
      "projects.list": () => [{ id: "p1", name: "Alpha", typeId: null, mainRelPath: null }],
      "settings.get": () => ({
        projectTemplate: {
          projectTypes: [
            { id: "research", name: "Research project", guidance: "" },
            { id: "software", name: "Software project", guidance: "" },
            { id: "paper", name: "Paper", guidance: "" },
          ],
        },
      }),
    })

    expect(await screen.findByLabelText("Tipo de proyecto")).toBeTruthy()
    expect(await screen.findByRole("option", { name: "Proyecto de investigación" })).toBeTruthy()
    expect(screen.getByRole("option", { name: "Proyecto de software" })).toBeTruthy()
    expect(screen.getByRole("option", { name: "Artículo" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Planificar este proyecto" })).toBeTruthy()
  })

  test("Project view shows a known type error in the selected language", async () => {
    window.localStorage.setItem("pi-lab.interface.language", "es")
    renderSection(<ProjectViewSection />, {
      "projects.list": () => [{ id: "p1", name: "Alpha", typeId: null, mainRelPath: null }],
      "settings.get": () => ({
        projectTemplate: {
          projectTypes: [
            { id: "research", name: "Research project", guidance: "" },
            { id: "software", name: "Software project", guidance: "" },
            { id: "paper", name: "Paper", guidance: "" },
          ],
        },
      }),
      "projects.setType": () => {
        throw new Error("Unknown project type")
      },
    })

    await screen.findByRole("option", { name: "Artículo" })
    fireEvent.change(screen.getByLabelText("Tipo de proyecto"), {
      target: { value: "paper" },
    })
    expect((await screen.findByRole("alert")).textContent).toContain("Tipo de proyecto desconocido")
  })

  test("Sections shows four rows; Cluster/Analysis toggle, Experiments/Research Heartbeat not-yet-available", () => {
    renderSection(<SectionsSection />)

    // All four rows are present, defaulting to shown.
    const cluster = screen.getByTestId("settings-show-cluster-section")
    const analysis = screen.getByTestId("settings-show-analysis-section")
    const experiments = screen.getByTestId("settings-show-experiments-section")
    const heartbeat = screen.getByTestId("settings-show-research-heartbeat-section")
    expect(cluster.getAttribute("aria-checked")).toBe("true")
    expect(analysis.getAttribute("aria-checked")).toBe("true")

    // The unbuilt sections are shown as not-yet-available (disabled toggles).
    expect((experiments as HTMLButtonElement).disabled).toBe(true)
    expect((heartbeat as HTMLButtonElement).disabled).toBe(true)
    expect((cluster as HTMLButtonElement).disabled).toBe(false)

    // The live toggles persist their choice.
    fireEvent.click(cluster)
    expect(window.localStorage.getItem("pi-lab.sections.showCluster")).toBe("false")
    fireEvent.click(analysis)
    expect(window.localStorage.getItem("pi-lab.sections.showAnalysis")).toBe("false")
  })

  test("Editor section round-trips an autosave patch through settings.updateEditor", async () => {
    const patches: unknown[] = []
    renderSection(<EditorSection />, {
      "settings.get": () => ({
        editor: {
          autosave: false,
          vim: false,
          diagnosticsEnabled: false,
          typeChecker: "ty",
          formatOnSave: false,
          editorTheme: "default",
        },
      }),
      "settings.updateEditor": (input) => {
        patches.push(input)
        return {
          editor: {
            autosave: true,
            vim: false,
            diagnosticsEnabled: false,
            typeChecker: "ty",
            formatOnSave: false,
            editorTheme: "default",
          },
        }
      },
    })

    await waitFor(() => expect(screen.getByTestId("settings-editor-autosave")).toBeTruthy())
    fireEvent.click(screen.getByTestId("settings-editor-autosave"))
    await waitFor(() => expect(patches).toContainEqual({ autosave: true }))
  })

  test("Editor section round-trips the persisted diagnostics toggle", async () => {
    const patches: unknown[] = []
    renderSection(<EditorSection />, {
      "settings.get": () => ({
        editor: {
          autosave: false,
          vim: false,
          diagnosticsEnabled: false,
          typeChecker: "ty",
          formatOnSave: false,
          editorTheme: "default",
        },
      }),
      "settings.updateEditor": (input) => {
        patches.push(input)
        if (
          "customEditorThemes" in (input as object) &&
          (input as { customEditorThemes?: unknown[] }).customEditorThemes?.length === 0
        ) {
          throw new Error("Could not persist editor themes")
        }
        return input
      },
    })

    const toggle = await screen.findByTestId("settings-editor-diagnostics")
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    fireEvent.click(toggle)
    await waitFor(() => expect(patches).toContainEqual({ diagnosticsEnabled: true }))
  })

  test("Editor section round-trips an editor-theme patch through settings.updateEditor", async () => {
    const patches: unknown[] = []
    renderSection(<EditorSection />, {
      "settings.get": () => ({
        editor: {
          autosave: false,
          vim: false,
          diagnosticsEnabled: false,
          typeChecker: "ty",
          formatOnSave: false,
          editorTheme: "default",
        },
      }),
      "settings.updateEditor": (input) => {
        patches.push(input)
        return {
          editor: {
            autosave: false,
            vim: false,
            diagnosticsEnabled: false,
            typeChecker: "ty",
            formatOnSave: false,
            editorTheme: "tokyo-night",
          },
        }
      },
    })

    await waitFor(() => expect(screen.getByTestId("settings-editor-theme")).toBeTruthy())
    fireEvent.change(screen.getByTestId("settings-editor-theme"), {
      target: { value: "tokyo-night" },
    })
    await waitFor(() => expect(patches).toContainEqual({ editorTheme: "tokyo-night" }))
  })

  test("Editor theme picker groups Light themes before Dark, each label suffixed", async () => {
    renderSection(<EditorSection />, {
      "settings.get": () => ({
        editor: {
          autosave: false,
          vim: false,
          diagnosticsEnabled: false,
          typeChecker: "ty",
          formatOnSave: false,
          editorTheme: "default",
        },
      }),
    })

    const select = await screen.findByTestId<HTMLSelectElement>("settings-editor-theme")
    const groups = Array.from(select.querySelectorAll("optgroup"))
    expect(groups.map((group) => group.label)).toEqual(["Light", "Dark"])

    const lightOptions = Array.from(groups[0]?.querySelectorAll("option") ?? [])
    const darkOptions = Array.from(groups[1]?.querySelectorAll("option") ?? [])
    expect(lightOptions.length + darkOptions.length).toBeGreaterThanOrEqual(12)
    expect(lightOptions.length).toBeGreaterThanOrEqual(4)
    expect(darkOptions.length).toBeGreaterThanOrEqual(4)
    for (const option of lightOptions) expect(option.textContent?.endsWith("(Light)")).toBe(true)
    for (const option of darkOptions) expect(option.textContent?.endsWith("(Dark)")).toBe(true)

    // A legacy/unknown stored id normalizes to the default light theme for display.
    expect(select.value).toBe("solarized-light")
  })

  test("Editor custom-theme gallery selects/removes persisted themes and shows import errors", async () => {
    const patches: unknown[] = []
    const custom = {
      id: "custom:ocean:abc",
      name: "Ocean",
      mode: "dark" as const,
      colors: { background: "#102030", foreground: "#ddeeff" },
      tokenColors: [],
    }
    renderSection(<EditorSection />, {
      "settings.get": () => ({
        editor: {
          autosave: false,
          vim: false,
          diagnosticsEnabled: false,
          typeChecker: "ty",
          formatOnSave: false,
          editorTheme: custom.id,
          customEditorThemes: [custom],
          pythonRunDestination: "central",
        },
      }),
      "settings.updateEditor": (input) => {
        patches.push(input)
        if (typeof input === "object" && input !== null && "customEditorThemes" in input) {
          throw new Error("Could not persist editor themes")
        }
        return input
      },
      "system.importEditorThemes": () => ({
        themes: [],
        errors: [{ filename: "bad.json", message: "Theme file is not valid JSON" }],
      }),
    })

    expect(await screen.findByTestId("settings-custom-editor-theme")).toBeTruthy()
    fireEvent.click(screen.getByTestId(`settings-remove-editor-theme-${custom.id}`))
    await waitFor(() =>
      expect(patches).toContainEqual({
        customEditorThemes: [],
        editorTheme: "solarized-light",
      }),
    )
    await waitFor(() =>
      expect(screen.getByTestId("settings-editor-theme-errors").textContent).toContain(
        "Could not persist editor themes",
      ),
    )

    fireEvent.click(screen.getByTestId("settings-import-editor-themes"))
    await waitFor(() =>
      expect(screen.getByTestId("settings-editor-theme-errors").textContent).toContain("bad.json"),
    )
  })
})
