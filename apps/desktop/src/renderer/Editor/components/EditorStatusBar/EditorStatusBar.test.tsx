import { act, render, screen } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { setInterfaceLanguage } from "../../../i18n/language"
import { EditorStatusBar } from "./EditorStatusBar"

afterEach(() => setInterfaceLanguage("en"))

test("updates Markdown view controls when the interface language changes", () => {
  render(
    <EditorStatusBar
      isPython={false}
      counts={{ errors: 0, warnings: 0, infos: 0 }}
      missing={[]}
      checking={false}
      hasRun={false}
      outdated={false}
      onRefreshDiagnostics={() => {}}
      diagnosticsEnabled={false}
      onToggleDiagnostics={vi.fn()}
      pythonRuntime={{ runtime: null, checking: false, error: null }}
      listPythonEnvironments={async () => []}
      selectPythonEnvironment={async () => true}
      choosePythonEnvironment={async () => true}
      markdownMode="render"
      onMarkdownModeChange={vi.fn()}
    />,
  )

  act(() => setInterfaceLanguage("ja"))
  expect(screen.getByRole("group", { name: "Markdown 表示" })).toBeTruthy()
  expect(screen.getByRole("button", { name: "Markdown を表示" })).toBeTruthy()
})
