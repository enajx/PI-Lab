import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import type { CloseTabRequest } from "../../shared/closeTab"
import type { QuickEditBridge, QuickEditTarget } from "../../shared/quickEdit"
import { installCloseTabResponder } from "../shortcuts/closeTab"
import { QuickEditor } from "./QuickEditor"
import { readQuickBuffer } from "./quickEditorState"

// Exercise the component's async lifecycle through injected IPC; editor rendering is mocked.
vi.mock("../Editor/components/CodeMirrorBuffer", () => ({
  CodeMirrorBuffer: (props: { initialDoc: string; onChange: (content: string) => void }) => (
    <textarea
      aria-label="Document"
      value={props.initialDoc}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}))
vi.mock("../providers/ThemeProvider", () => ({
  useTheme: () => ({ resolvedMode: "light" }),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const baseline = { exists: true, mtimeMs: 1, size: 3 }
const text = (content: string) => ({
  status: "text" as const,
  exists: true as const,
  content,
  baseline,
})

function installBridge(current: QuickEditTarget, read: QuickEditBridge["read"]) {
  let open!: (target: QuickEditTarget) => void
  const bridge = {
    current: async () => current,
    read,
    stat: async () => ({ ...baseline, mtimeMs: 2 }),
    ready: vi.fn(),
    save: vi.fn<QuickEditBridge["save"]>(),
    subscribeOpen: (listener: typeof open) => {
      open = listener
      return () => {}
    },
    subscribeEditorVim: () => () => {},
  }
  Object.defineProperty(window, "piLab", {
    configurable: true,
    value: { quickEdit: bridge },
  })
  return { open: (target: QuickEditTarget) => open(target), bridge }
}

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(window, "piLab", { configurable: true, value: undefined })
})

test("a later open wins over an earlier pending initial read", async () => {
  const first = deferred<Awaited<ReturnType<QuickEditBridge["read"]>>>()
  const original = { id: "load-original", path: "/tmp/original.txt" }
  const latest = { id: "load-latest", path: "/tmp/latest.txt" }
  const read = vi.fn(async (id: string) =>
    id === original.id ? first.promise : text("latest file"),
  )
  const bridge = installBridge(original, read)
  render(<QuickEditor fullApp={false} />)
  await waitFor(() => expect(read).toHaveBeenCalledWith(original.id))
  await act(async () => bridge.open(latest))
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("latest file")
  await act(async () => first.resolve(text("earlier file")))
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("latest file")
})

test("a later open wins over an earlier pending current-target lookup", async () => {
  const original = { id: "current-original", path: "/tmp/current-original.txt" }
  const latest = { id: "current-latest", path: "/tmp/current-latest.txt" }
  const current = deferred<QuickEditTarget>()
  const bridge = installBridge(original, async (id) =>
    text(id === latest.id ? "new open" : "obsolete lookup"),
  )
  bridge.bridge.current = () => current.promise
  render(<QuickEditor fullApp={false} />)
  await act(async () => bridge.open(latest))
  await act(async () => current.resolve(original))
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("new open")
})

test("a newer file request wins while an older open is saving the current draft", async () => {
  const saved = deferred<Awaited<ReturnType<QuickEditBridge["save"]>>>()
  const original = { id: "open-saving-original", path: "/tmp/original.txt" }
  const middle = { id: "open-saving-middle", path: "/tmp/middle.txt" }
  const latest = { id: "open-saving-latest", path: "/tmp/latest.txt" }
  const bridge = installBridge(original, async (id) => text(id))
  bridge.bridge.save.mockReturnValueOnce(saved.promise)
  render(<QuickEditor fullApp={false} />)
  await screen.findByRole("textbox")
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "save this draft" } })
  await act(async () => bridge.open(middle))
  await act(async () => bridge.open(latest))
  await act(async () => saved.resolve({ status: "saved", baseline }))
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(latest.id)
})

test("automatic reload preserves edits made while its read is pending", async () => {
  vi.useFakeTimers()
  const reload = deferred<Awaited<ReturnType<QuickEditBridge["read"]>>>()
  const read = vi.fn().mockResolvedValueOnce(text("old")).mockReturnValueOnce(reload.promise)
  installBridge({ id: "reload-edit", path: "/tmp/reload.txt" }, read)
  await act(async () => render(<QuickEditor fullApp={false} />))
  await act(async () => vi.advanceTimersByTimeAsync(1_500))
  expect(read).toHaveBeenCalledTimes(2)
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "new draft" } })
  await act(async () => reload.resolve(text("external edit")))
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("new draft")
  expect(screen.getByRole("alert").textContent).toContain("changed on disk")
})

test("save completion updates the remounted quick draft baseline without replacing newer edits", async () => {
  const saved = deferred<Awaited<ReturnType<QuickEditBridge["save"]>>>()
  const { bridge } = installBridge(
    { id: "save-remount", path: "/tmp/save-remount.txt" },
    async () => text("old"),
  )
  bridge.save.mockReturnValueOnce(saved.promise)
  const first = render(<QuickEditor fullApp={false} />)
  await screen.findByRole("textbox")
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "written draft" } })
  fireEvent.click(screen.getByRole("button", { name: /^Save$/ }))
  first.unmount()
  render(<QuickEditor fullApp={false} />)
  await screen.findByRole("textbox")
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "newer draft" } })
  const savedBaseline = { exists: true, mtimeMs: 3, size: 13 }
  await act(async () => saved.resolve({ status: "saved", baseline: savedBaseline }))
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("newer draft")
  expect(readQuickBuffer("save-remount")?.content).toBe("newer draft")
  bridge.save.mockResolvedValueOnce({ status: "saved", baseline: savedBaseline })
  fireEvent.click(screen.getByRole("button", { name: /^Save$/ }))
  expect(bridge.save).toHaveBeenLastCalledWith("save-remount", "newer draft", savedBaseline, false)
})

/** Send one Cmd+W request through the renderer responder (fake preload bridge). */
function pressCmdW(): boolean {
  let listener: ((request: CloseTabRequest) => void) | null = null
  const answers: boolean[] = []
  const uninstall = installCloseTabResponder({
    subscribe: (next) => {
      listener = next
      return () => {
        listener = null
      }
    },
    respond: (response) => answers.push(response.handled),
  })
  act(() => listener?.({ requestId: "cmd-w" }))
  uninstall()
  expect(answers).toHaveLength(1)
  return answers[0] as boolean
}

test("Cmd+W in the full-app Editor closes a saved file and asks before closing a dirty one", async () => {
  const target = { id: "cmd-w-editor", path: "/tmp/cmd-w-editor.txt" }
  const { bridge } = installBridge(target, async () => text("abc"))
  const close = vi.fn(async () => {})
  Object.assign(bridge, { close, subscribeRoute: () => () => {} })
  const view = render(<QuickEditor fullApp targetId={target.id} />)
  await screen.findByRole("textbox")
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "abc changed" } })
  expect(pressCmdW()).toBe(true)
  expect(screen.getByRole("dialog", { name: "Close editor file" })).toBeTruthy()
  expect(close).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "abc" } })
  expect(pressCmdW()).toBe(true)
  await waitFor(() => expect(close).toHaveBeenCalledWith(target.id))
  view.unmount()
  expect(pressCmdW()).toBe(false)
})

test("Cmd+W in an empty full-app Editor or the standalone quick editor backgrounds the app", async () => {
  const { bridge } = installBridge({ id: "cmd-w-quick", path: "/tmp/cmd-w-quick.txt" }, async () =>
    text("abc"),
  )
  const quick = render(<QuickEditor fullApp={false} />)
  await screen.findByRole("textbox")
  expect(pressCmdW()).toBe(false)
  quick.unmount()
  Object.assign(bridge, { subscribeRoute: () => () => {} })
  render(<QuickEditor fullApp />)
  await screen.findByTestId("quick-editor-full-app")
  expect(pressCmdW()).toBe(false)
})

test("the full-app Editor tab × asks before closing a dirty file and closes a clean one", async () => {
  const target = { id: "x-editor", path: "/tmp/x-editor.txt" }
  const { bridge } = installBridge(target, async () => text("abc"))
  const close = vi.fn(async () => {})
  Object.assign(bridge, { close, subscribeRoute: () => () => {} })
  render(<QuickEditor fullApp targetId={target.id} />)
  await screen.findByRole("textbox")
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "abc changed" } })
  fireEvent.click(screen.getByTestId("quick-editor-tab-close"))
  expect(screen.getByRole("dialog", { name: "Close editor file" })).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  expect(close).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "abc" } })
  fireEvent.click(screen.getByTestId("quick-editor-tab-close"))
  await waitFor(() => expect(close).toHaveBeenCalledWith(target.id))
})
