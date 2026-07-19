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
} from "./SettingsSections"

/**
 * Component tests for the Settings sections (plan "Settings panel, project-view
 * rework"): the theme picker drives the existing ThemeProvider, renderer-only
 * prefs persist to localStorage, and DB-backed editor settings round-trip through
 * the `settings` router (faked over an in-memory link).
 */

function renderSection(node: React.ReactNode, handlers: FakeHandlers = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(handlers)
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
  test("Appearance mode picker toggles the .dark class", async () => {
    renderSection(<AppearanceSection />)
    // ThemeProvider defaults to light and applies it on mount (no .dark).
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(false))

    fireEvent.change(screen.getByTestId("settings-theme-mode"), { target: { value: "dark" } })
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true))
  })

  test("Appearance gallery selects and applies a named app theme", async () => {
    renderSection(<AppearanceSection />)
    expect(screen.getAllByRole("button")).toHaveLength(9)
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

  test("Notifications section persists a complete next event configuration", async () => {
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
        ...notifications,
        workflowStart: { enabled: true, sound: "pulse" },
      }),
    )

    fireEvent.click(screen.getByRole("switch", { name: "Agent finished its turn notifications" }))
    await waitFor(() =>
      expect(updates).toContainEqual({
        ...notifications,
        agentTurnCompletion: { enabled: false, sound: "success" },
      }),
    )

    fireEvent.change(screen.getByRole("combobox", { name: "Agent needs input sound" }), {
      target: { value: "silent" },
    })
    await waitFor(() =>
      expect(updates).toContainEqual({
        ...notifications,
        agentInput: { enabled: true, sound: "silent" },
      }),
    )
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
