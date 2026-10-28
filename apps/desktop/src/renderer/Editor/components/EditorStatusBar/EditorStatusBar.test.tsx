import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { setInterfaceLanguage } from "../../../i18n/language"
import { EditorStatusBar } from "./EditorStatusBar"

afterEach(() => setInterfaceLanguage("en"))

test("updates Markdown view controls when the interface language changes", () => {
  render(
    <EditorStatusBar
      label="file"
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

/** The build summary shares the editor baseline and exposes its logs above the bar. */
test("shows LaTeX build status beside Python and toggles an upward log panel", () => {
  render(
    <EditorStatusBar
      label="file"
      isPython={true}
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
      latexBuildStatus={{ message: "LaTeX build failed", log: "Compiler diagnostic\nline 12" }}
    />,
  )
  const bar = screen.getByTestId("editor-status-bar")
  const status = within(bar).getByTestId("latex-build-status")
  expect(within(bar).getByTestId("editor-python-runtime")).toBeTruthy()
  const toggle = within(status).getByRole("button", { name: "LaTeX build failed" })
  expect(toggle.getAttribute("aria-expanded")).toBe("false")
  expect(screen.queryByTestId("latex-build-log")).toBeNull()
  toggle.focus()
  fireEvent.click(toggle)
  expect(toggle.getAttribute("aria-expanded")).toBe("true")
  const log = within(status).getByTestId("latex-build-log")
  expect(log.textContent).toContain("Compiler diagnostic")
  fireEvent.keyDown(document, { key: "Escape" })
  expect(screen.queryByTestId("latex-build-log")).toBeNull()
  expect(toggle.getAttribute("aria-expanded")).toBe("false")
  fireEvent.click(toggle)
  expect(screen.getByTestId("latex-build-log")).toBeTruthy()
  fireEvent.mouseDown(document.body)
  expect(screen.queryByTestId("latex-build-log")).toBeNull()
})

/** The single panel bar always names the focused tab, so it is never an empty strip. */
test("names the focused tab even when it has no controls", () => {
  render(
    <EditorStatusBar
      label="cli.ts"
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
      latexBuildStatus={null}
    />,
  )

  expect(screen.getByTestId("editor-status-label").textContent).toBe("cli.ts")
})
