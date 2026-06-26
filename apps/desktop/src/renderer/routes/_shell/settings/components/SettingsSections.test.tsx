import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, test } from "vitest"
import { AppProviders } from "../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../test/fakeTrpcClient"
import {
  AppearanceSection,
  EditorSection,
  GeneralSection,
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
  test("Appearance theme picker toggles the .dark class", async () => {
    renderSection(<AppearanceSection />)
    // ThemeProvider defaults to light and applies it on mount (no .dark).
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(false))

    fireEvent.change(screen.getByTestId("settings-theme"), { target: { value: "dark" } })
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true))
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
    fireEvent.click(screen.getByTestId("settings-confirm-quit"))
    await waitFor(() => expect(patches).toContainEqual({ confirmOnQuit: false }))
  })

  test('Project view toggle persists "show code changes"', () => {
    renderSection(<ProjectViewSection />)
    fireEvent.click(screen.getByTestId("settings-show-code-changes"))
    expect(window.localStorage.getItem("skipper.projectView.showCodeChanges")).toBe("true")
  })

  test("Editor section round-trips an autosave patch through settings.updateEditor", async () => {
    const patches: unknown[] = []
    renderSection(<EditorSection />, {
      "settings.get": () => ({
        editor: {
          autosave: false,
          vim: false,
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

  test("Editor section round-trips an editor-theme patch through settings.updateEditor", async () => {
    const patches: unknown[] = []
    renderSection(<EditorSection />, {
      "settings.get": () => ({
        editor: {
          autosave: false,
          vim: false,
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
    expect(lightOptions).toHaveLength(4)
    expect(darkOptions).toHaveLength(4)
    for (const option of lightOptions) expect(option.textContent?.endsWith("(Light)")).toBe(true)
    for (const option of darkOptions) expect(option.textContent?.endsWith("(Dark)")).toBe(true)

    // A legacy/unknown stored id normalizes to the default light theme for display.
    expect(select.value).toBe("solarized-light")
  })
})
