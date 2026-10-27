import { act, renderHook, waitFor } from "@testing-library/react"
import { expect, test, vi } from "vitest"
import { createFakeTrpcClient } from "../../../../../test/fakeTrpcClient"
import { useLatexBuild } from "./useLatexBuild"

interface BuildResult {
  relPath: string
  success: boolean
  log: string
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Mocked IPC: pending workspace builds keep the viewer gated despite an earlier result. */
test("tracks concurrent roots and preserves failed output across another root's success", async () => {
  const first = deferred<BuildResult>()
  const second = deferred<BuildResult>()
  const third = deferred<BuildResult>()
  const build = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(third.promise)
  const saved = vi.fn()
  const client = createFakeTrpcClient({
    "pdf.build": build,
    "files.stat": () => ({ exists: true, mtimeMs: 10, size: 20 }),
  })
  const view = renderHook(() => useLatexBuild(client, "workspace", saved))
  act(() => {
    view.result.current.saved("a.tex")
    view.result.current.saved("b.tex")
  })
  expect(saved.mock.calls).toEqual([["a.tex"], ["b.tex"]])
  expect(view.result.current.pdfBuildState?.state).toBe("building")
  await act(async () => first.resolve({ relPath: "build/a.pdf", success: false, log: "A failed" }))
  await waitFor(() =>
    expect(view.result.current.pdfBuildState?.failedOutputs["build/a.pdf"]).toEqual({
      mtimeMs: 10,
      size: 20,
    }),
  )
  expect(view.result.current.pdfBuildState?.state).toBe("building")
  expect(view.result.current.status?.message).toContain("Building")
  await act(async () => second.resolve({ relPath: "build/b.pdf", success: true, log: "B built" }))
  expect(view.result.current.pdfBuildState?.state).toBe("failed")
  expect(view.result.current.status?.log).toContain("A failed")
  expect(view.result.current.pdfBuildState?.failedOutputs["build/a.pdf"]).toBeDefined()
  act(() => view.result.current.saved("a.tex"))
  await act(async () => third.resolve({ relPath: "build/a.pdf", success: true, log: "A built" }))
  expect(view.result.current.pdfBuildState?.state).toBe("complete")
  expect(view.result.current.pdfBuildState?.failedOutputs).toEqual({})
})

/** Mocked IPC: an older root failure remains visible when its response arrives last. */
test("accepts results from different roots out of order", async () => {
  const first = deferred<BuildResult>()
  const second = deferred<BuildResult>()
  const client = createFakeTrpcClient({
    "pdf.build": vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    "files.stat": () => ({ exists: true, mtimeMs: 30, size: 40 }),
  })
  const view = renderHook(() => useLatexBuild(client, "workspace", undefined))
  act(() => {
    view.result.current.saved("a.tex")
    view.result.current.saved("b.tex")
  })
  await act(async () => second.resolve({ relPath: "build/b.pdf", success: true, log: "B built" }))
  expect(view.result.current.pdfBuildState?.state).toBe("building")
  await act(async () =>
    first.resolve({ relPath: "build/a.pdf", success: false, log: "A failed late" }),
  )
  expect(view.result.current.status?.log).toContain("A failed late")
  expect(view.result.current.pdfBuildState?.state).toBe("failed")
})

/** Mocked IPC: stat failures retain compiler diagnostics, and command errors surface. */
test("retains compiler log if output stat fails and reports missing commands", async () => {
  const client = createFakeTrpcClient({
    "pdf.build": vi
      .fn()
      .mockResolvedValueOnce({
        relPath: "build/a.pdf",
        success: false,
        log: "Original compiler diagnostic",
      })
      .mockRejectedValueOnce(new Error("latexmk missing")),
    "files.stat": () => {
      throw new Error("permission denied")
    },
  })
  const view = renderHook(() => useLatexBuild(client, "workspace", undefined))
  act(() => view.result.current.saved("a.tex"))
  await waitFor(() => expect(view.result.current.pdfBuildState?.state).toBe("failed"))
  expect(view.result.current.status?.log).toContain("Original compiler diagnostic")
  expect(view.result.current.status?.log).toContain("permission denied")
  act(() => view.result.current.saved("b.tex"))
  await waitFor(() => expect(view.result.current.status?.log).toContain("latexmk missing"))
})

/** Mocked IPC: workspace changes retire all old response ownership. */
test("ignores old workspace results and only builds tex saves", async () => {
  const pending = deferred<BuildResult>()
  const build = vi.fn(() => pending.promise)
  const saved = vi.fn()
  const client = createFakeTrpcClient({ "pdf.build": build })
  const view = renderHook(({ workspace }) => useLatexBuild(client, workspace, saved), {
    initialProps: { workspace: "old" },
  })
  act(() => {
    view.result.current.saved("notes.md")
    view.result.current.saved("main.tex")
  })
  expect(build).toHaveBeenCalledTimes(1)
  view.rerender({ workspace: "new" })
  expect(view.result.current.status).toBeNull()
  await act(async () =>
    pending.resolve({ relPath: "build/main.pdf", success: true, log: "Old build" }),
  )
  expect(view.result.current.status).toBeNull()
  view.unmount()
})

/** Mocked IPC: a slow stat from a failed build cannot suppress its later successful rebuild. */
test("a successful rebuild clears a failure whose stat response is still pending", async () => {
  const stat = deferred<{ exists: boolean; mtimeMs: number; size: number }>()
  const build = vi
    .fn()
    .mockResolvedValueOnce({ relPath: "build/a.pdf", success: false, log: "failed" })
    .mockResolvedValueOnce({ relPath: "build/a.pdf", success: true, log: "fixed" })
  const client = createFakeTrpcClient({ "pdf.build": build, "files.stat": () => stat.promise })
  const view = renderHook(() => useLatexBuild(client, "workspace", undefined))
  await act(async () => view.result.current.saved("a.tex"))
  await act(async () => view.result.current.saved("a.tex"))
  await act(async () => stat.resolve({ exists: true, mtimeMs: 50, size: 60 }))
  expect(view.result.current.pdfBuildState?.state).toBe("complete")
  expect(view.result.current.pdfBuildState?.failedOutputs).toEqual({})
})

/** Mocked IPC: changing a source's root cannot clear a failed, different PDF output. */
test("success clears only the matching output even when the saved source is the same", async () => {
  const build = vi
    .fn()
    .mockResolvedValueOnce({ relPath: "build/a.pdf", success: false, log: "A failed" })
    .mockResolvedValueOnce({ relPath: "build/b.pdf", success: true, log: "B built" })
  const client = createFakeTrpcClient({
    "pdf.build": build,
    "files.stat": () => ({ exists: true, mtimeMs: 1, size: 2 }),
  })
  const view = renderHook(() => useLatexBuild(client, "workspace", undefined))
  await act(async () => view.result.current.saved("chapter.tex"))
  await act(async () => view.result.current.saved("chapter.tex"))
  expect(view.result.current.pdfBuildState?.failedOutputs).toEqual({
    "build/a.pdf": { mtimeMs: 1, size: 2 },
  })
  expect(view.result.current.status?.log).toContain("A failed")
})
