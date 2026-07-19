import {
  DEFAULT_CAFFEINE_SETTINGS,
  DEFAULT_EDITOR_SETTINGS,
  DEFAULT_NOTIFICATION_SETTINGS,
  type EditorSettings,
  settings,
} from "@pi-lab/local-db"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createHarness, type Harness } from "../testHarness"

// Integration tests for the settings router over a real migrated SQLite DB
// (md/engineering/testing-and-build.md): a `get` against a fresh DB yields the editor defaults, and
// `updateEditor` upserts + merges the singleton row.

let harness: Harness

beforeEach(async () => {
  harness = await createHarness()
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
    })
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
      executableOverrides: { codex: "/usr/local/bin/codex" },
      setupCompleted: true,
    })
  })
})
