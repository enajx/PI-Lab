import {
  DEFAULT_CAFFEINE_SETTINGS,
  DEFAULT_EDITOR_SETTINGS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_PROJECT_TEMPLATE_SETTINGS,
  type EditorSettings,
  settings,
} from "@pi-lab/local-db"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { onPublicUpdateChannelChanged } from "../../updates/selection"
import { createHarness, type Harness } from "../testHarness"

// Integration tests for the settings router over a real migrated SQLite DB
// A `get` against a fresh DB yields the editor defaults, and
// `updateEditor` upserts + merges the singleton row.

let harness: Harness

beforeEach(async () => {
  harness = await createHarness([], { git: false, daemon: "lazy" })
})

afterEach(async () => {
  await harness.dispose()
})

describe("settings.get", () => {
  it("returns the editor defaults on a fresh database", async () => {
    const result = await harness.caller.settings.get()
    expect(result.editor).toEqual(DEFAULT_EDITOR_SETTINGS)
    expect(result.notifications).toEqual(DEFAULT_NOTIFICATION_SETTINGS)
    expect(result.notifications.muted).toBe(false)
    expect(result.notifications.agentInput.enabled).toBe(true)
    expect(result.notifications.agentTurnCompletion.enabled).toBe(true)
    expect(result.notifications.terminalCompletion.enabled).toBe(true)
    expect(result.notifications.workflowStart.enabled).toBe(false)
    expect(result.notifications.workflowCompletion.enabled).toBe(true)
    expect(result.notifications.workflowFailure.enabled).toBe(true)
    expect(result.caffeine).toEqual(DEFAULT_CAFFEINE_SETTINGS)
    expect(result.caffeine.mode).toBe("off")
    expect(result.caffeine.scope).toBe("system-only")
    expect(result.projectTemplate).toEqual(DEFAULT_PROJECT_TEMPLATE_SETTINGS)
  })

  it("deep-defaults diagnostics off for a legacy editor JSON blob", async () => {
    const legacyEditor = {
      autosave: true,
      vim: false,
      typeChecker: "pyrefly" as const,
      formatOnSave: true,
      editorTheme: "one-dark",
    }
    harness.db
      .insert(settings)
      .values({ id: 1, editor: legacyEditor as EditorSettings, updatedAt: 1 })
      .onConflictDoUpdate({
        target: settings.id,
        set: { editor: legacyEditor as EditorSettings, updatedAt: 1 },
      })
      .run()

    const result = await harness.caller.settings.get()
    expect(result.editor).toEqual({
      ...legacyEditor,
      diagnosticsEnabled: false,
      customEditorThemes: [],
      pythonRunDestination: "central",
      latexProvider: "bundled",
    })
  })
})

describe("settings.updateProjectTemplate", () => {
  it("persists the default Markdown selection and template parent independently", async () => {
    await harness.caller.settings.updateProjectTemplate({
      initializationMarkdownFiles: ["AGENTS.md", "TODO.md"],
    })
    const updated = await harness.caller.settings.updateProjectTemplate({
      defaultTemplateParentPath: "/Users/example/projects",
    })

    expect(updated).toMatchObject({
      initializationMarkdownFiles: ["AGENTS.md", "TODO.md"],
      defaultTemplateParentPath: "/Users/example/projects",
    })
    expect((await harness.caller.settings.get()).projectTemplate).toEqual(updated)
  })
})

describe("project types", () => {
  it("starts with Research, Software, and Manuscript and stores editable guidance", async () => {
    const initial = (await harness.caller.settings.get()).projectTemplate.projectTypes
    expect(initial.map((type) => type.id)).toEqual(["research", "software", "manuscript"])

    await harness.caller.settings.updateProjectTypeGuidance({
      id: "manuscript",
      guidance: "Focus on the manuscript and its evidence.",
    })

    expect((await harness.caller.settings.get()).projectTemplate.projectTypes).toEqual([
      initial[0],
      initial[1],
      { ...initial[2], guidance: "Focus on the manuscript and its evidence." },
    ])
  })

  it("keeps unknown saved type data without exposing it as a choice", async () => {
    harness.db
      .insert(settings)
      .values({
        id: 1,
        projectTemplate: {
          ...DEFAULT_PROJECT_TEMPLATE_SETTINGS,
          projectTypes: [
            ...DEFAULT_PROJECT_TEMPLATE_SETTINGS.projectTypes,
            { id: "custom-old", name: "Old custom", guidance: "Keep this data" },
          ],
        },
      })
      .run()

    expect((await harness.caller.settings.get()).projectTemplate.projectTypes).toHaveLength(3)
    await harness.caller.settings.updateProjectTypeGuidance({ id: "research", guidance: "Edited" })
    const stored = harness.db.select().from(settings).get()
    expect(
      stored?.projectTemplate.projectTypes.find((type) => type.id === "custom-old")?.guidance,
    ).toBe("Keep this data")
  })
})

describe("settings.updateNotifications", () => {
  it("persists a complete notification settings group", async () => {
    const updated = await harness.caller.settings.updateNotifications({
      muted: true,
      agentInput: { enabled: false, sound: "silent" },
      agentTurnCompletion: { enabled: true, sound: "success" },
      terminalCompletion: { enabled: false, sound: "alert" },
      workflowStart: { enabled: true, sound: "chime" },
      workflowCompletion: { enabled: false, sound: "pulse" },
      workflowFailure: { enabled: false, sound: "success" },
    })

    expect(updated).toEqual({
      muted: true,
      agentInput: { enabled: false, sound: "silent" },
      agentTurnCompletion: { enabled: true, sound: "success" },
      terminalCompletion: { enabled: false, sound: "alert" },
      workflowStart: { enabled: true, sound: "chime" },
      workflowCompletion: { enabled: false, sound: "pulse" },
      workflowFailure: { enabled: false, sound: "success" },
    })
    expect((await harness.caller.settings.get()).notifications).toEqual(updated)
  })

  it("deep-merges event patches without clobbering enablement or other events", async () => {
    await harness.caller.settings.updateNotifications({
      agentInput: { enabled: false },
      workflowStart: { enabled: true },
    })
    const updated = await harness.caller.settings.updateNotifications({
      agentInput: { sound: "alert" },
    })

    expect(updated.agentInput).toEqual({ enabled: false, sound: "alert" })
    expect(updated.agentTurnCompletion).toEqual(DEFAULT_NOTIFICATION_SETTINGS.agentTurnCompletion)
    expect(updated.workflowStart).toEqual({ enabled: true, sound: "pulse" })
    expect(updated.terminalCompletion).toEqual(DEFAULT_NOTIFICATION_SETTINGS.terminalCompletion)
    expect(updated.workflowCompletion).toEqual(DEFAULT_NOTIFICATION_SETTINGS.workflowCompletion)
  })

  it("rejects unknown sound ids", async () => {
    await expect(
      harness.caller.settings.updateNotifications({
        agentInput: { sound: "system-default" as "silent" },
      }),
    ).rejects.toThrow()
  })
})

describe("settings.updateEditor", () => {
  it("upserts the singleton row and returns the merged editor settings", async () => {
    const result = await harness.caller.settings.updateEditor({ vim: true, typeChecker: "pyrefly" })
    expect(result).toEqual({
      autosave: false,
      vim: true,
      diagnosticsEnabled: false,
      typeChecker: "pyrefly",
      formatOnSave: false,
      editorTheme: "default",
      customEditorThemes: [],
      pythonRunDestination: "central",
      latexProvider: "bundled",
    })

    // The patch persisted and `get` reflects it.
    const after = await harness.caller.settings.get()
    expect(after.editor).toEqual(result)
  })

  it("merges successive patches without clobbering untouched fields", async () => {
    await harness.caller.settings.updateEditor({ autosave: true })
    const merged = await harness.caller.settings.updateEditor({ formatOnSave: true })
    expect(merged).toEqual({
      autosave: true,
      vim: false,
      diagnosticsEnabled: false,
      typeChecker: "ty",
      formatOnSave: true,
      editorTheme: "default",
      customEditorThemes: [],
      pythonRunDestination: "central",
      latexProvider: "bundled",
    })
  })

  it("persists diagnostics enablement without clobbering other editor settings", async () => {
    await harness.caller.settings.updateEditor({ vim: true })
    const updated = await harness.caller.settings.updateEditor({ diagnosticsEnabled: true })

    expect(updated.diagnosticsEnabled).toBe(true)
    expect(updated.vim).toBe(true)
    expect((await harness.caller.settings.get()).editor.diagnosticsEnabled).toBe(true)
  })

  it("persists copied custom themes and the Run Python destination", async () => {
    const theme = {
      id: "custom:ocean:abc",
      name: "Ocean",
      mode: "dark" as const,
      colors: { background: "#102030", foreground: "#ddeeff" },
      tokenColors: [{ scopes: ["comment"], foreground: "#778899", fontStyle: "italic" }],
    }
    const updated = await harness.caller.settings.updateEditor({
      customEditorThemes: [theme],
      editorTheme: theme.id,
      pythonRunDestination: "below-editor",
    })

    expect(updated).toMatchObject({
      customEditorThemes: [theme],
      editorTheme: theme.id,
      pythonRunDestination: "below-editor",
    })
    expect(JSON.stringify((await harness.caller.settings.get()).editor)).not.toContain("sourcePath")
  })
})

describe("settings.updateGeneral", () => {
  it("moves a saved Nightly choice to Stable before starting updates", async () => {
    harness.db
      .insert(settings)
      .values({ id: 1, publicUpdateChannel: "nightly" as "beta", updatedAt: 1 })
      .run()
    expect((await harness.caller.settings.get()).publicUpdateChannel).toBe("stable")
    await harness.caller.settings.updateGeneral({ confirmOnQuit: false })
    expect(harness.db.select().from(settings).get()?.publicUpdateChannel).toBe("stable")
  })

  it("notifies the running updater only when the selected channel changes", async () => {
    const changed = vi.fn()
    const unsubscribe = onPublicUpdateChannelChanged(changed)
    await harness.caller.settings.updateGeneral({ confirmOnQuit: false })
    await harness.caller.settings.updateGeneral({ publicUpdateChannel: "stable" })
    expect(changed).not.toHaveBeenCalled()
    await harness.caller.settings.updateGeneral({ publicUpdateChannel: "beta" })
    expect(changed).toHaveBeenCalledExactlyOnceWith("beta")
    unsubscribe()
  })

  it("defaults to Stable and persists a public update channel without changing other settings", async () => {
    expect((await harness.caller.settings.get()).publicUpdateChannel).toBe("stable")
    await harness.caller.settings.updateGeneral({ confirmOnQuit: false })
    const updated = await harness.caller.settings.updateGeneral({ publicUpdateChannel: "beta" })
    expect(updated.publicUpdateChannel).toBe("beta")
    expect(updated.confirmOnQuit).toBe(false)
    expect((await harness.caller.settings.get()).publicUpdateChannel).toBe("beta")
    await expect(
      harness.caller.settings.updateGeneral({ publicUpdateChannel: "nightly" as "stable" }),
    ).rejects.toThrow()
    await expect(
      harness.caller.settings.updateGeneral({ publicUpdateChannel: "preview" as "stable" }),
    ).rejects.toThrow()
  })

  it("keeps the app running after window close by default and persists an opt-out", async () => {
    expect((await harness.caller.settings.get()).keepRunningAfterClose).toBe(true)
    const updated = await harness.caller.settings.updateGeneral({ keepRunningAfterClose: false })
    expect(updated.keepRunningAfterClose).toBe(false)
    expect((await harness.caller.settings.get()).keepRunningAfterClose).toBe(false)
    await harness.caller.settings.updateGeneral({ confirmOnQuit: false })
    expect((await harness.caller.settings.get()).keepRunningAfterClose).toBe(false)
  })

  it("round-trips worktreePerAgent and confirmOnQuit", async () => {
    const updated = await harness.caller.settings.updateGeneral({
      worktreePerAgent: true,
      confirmOnQuit: false,
    })
    expect(updated.worktreePerAgent).toBe(true)
    expect(updated.confirmOnQuit).toBe(false)

    // The patch persisted and `get` reflects it.
    const after = await harness.caller.settings.get()
    expect(after.worktreePerAgent).toBe(true)
    expect(after.confirmOnQuit).toBe(false)
  })

  it("patches one field without clobbering the other", async () => {
    await harness.caller.settings.updateGeneral({ worktreePerAgent: true })
    const merged = await harness.caller.settings.updateGeneral({ confirmOnQuit: false })
    // worktreePerAgent stays on (default confirmOnQuit was true, now flipped off).
    expect(merged.worktreePerAgent).toBe(true)
    expect(merged.confirmOnQuit).toBe(false)
  })
})

describe("settings.updateAgents", () => {
  it("persists the project-config storage policy and executable overrides", async () => {
    const result = await harness.caller.settings.updateAgents({
      projectConfigStorage: "both",
      executableOverrides: { codex: "/opt/homebrew/bin/codex" },
    })
    expect(result).toEqual({
      projectConfigStorage: "both",
      quitBehavior: "stop",
      launchDefaults: {},
      defaultAgentId: null,
      executableOverrides: { codex: "/opt/homebrew/bin/codex" },
      setupCompleted: false,
    })
    expect((await harness.caller.settings.get()).agents).toEqual(result)
  })

  it("persists first-run setup completion without clobbering launch settings", async () => {
    await harness.caller.settings.updateAgents({
      projectConfigStorage: "project",
      executableOverrides: { codex: "/usr/local/bin/codex" },
    })
    const result = await harness.caller.settings.updateAgents({ setupCompleted: true })
    expect(result).toEqual({
      projectConfigStorage: "project",
      quitBehavior: "stop",
      launchDefaults: {},
      defaultAgentId: null,
      executableOverrides: { codex: "/usr/local/bin/codex" },
      setupCompleted: true,
    })
  })
})

describe("global LaTeX provider", () => {
  it("persists system and bundled choices while retaining saved settings", async () => {
    await harness.caller.settings.updateEditor({ autosave: true, vim: true })
    await harness.caller.settings.updateGeneral({ confirmOnQuit: false })
    await harness.caller.settings.updateEditor({ latexProvider: "system" })
    expect((await harness.caller.settings.get()).editor).toMatchObject({
      latexProvider: "system",
      autosave: true,
      vim: true,
    })
    expect((await harness.caller.settings.get()).confirmOnQuit).toBe(false)
    await harness.caller.settings.updateEditor({ latexProvider: "bundled" })
    expect((await harness.caller.settings.get()).editor.latexProvider).toBe("bundled")
    await expect(
      harness.caller.settings.updateEditor({ latexProvider: "managed" as never }),
    ).rejects.toThrow()
  })
})
