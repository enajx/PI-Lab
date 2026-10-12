import { act, renderHook } from "@testing-library/react"
import { expect, test } from "vitest"
import { createFakeTrpcClient } from "../../../test/fakeTrpcClient"
import { DEFAULT_EDITOR_SETTINGS, type OpenBuffer, useEditorBuffers } from "./useEditorBuffers"

test("a file removed during formatting preserves the draft and cannot report saved (mocked IPC)", async () => {
  const initial: OpenBuffer = {
    relPath: "main.py",
    content: "old",
    savedContent: "old",
    baseline: { mtimeMs: 1, size: 3 },
    externalChange: false,
    epoch: 0,
  }
  const client = createFakeTrpcClient({
    "python.resolve": () => null,
    "files.stat": () => ({ exists: true, mtimeMs: 1, size: 3 }),
    "files.write": () => ({
      bytes: 5,
      baseline: { exists: true, mtimeMs: 2, size: 5 },
      matchesWrittenContent: true,
    }),
    "diagnostics.format": () => ({ changed: true }),
    "files.read": () => ({
      status: "missing",
      exists: false,
      content: "",
      baseline: { exists: false, mtimeMs: 0, size: 0 },
    }),
  })
  const view = renderHook(() =>
    useEditorBuffers({
      client,
      workspaceId: "review-missing-formatter",
      initialBuffers: [initial],
      initialActiveRelPath: initial.relPath,
      settings: {
        ...DEFAULT_EDITOR_SETTINGS,
        diagnosticsEnabled: false,
        autosave: false,
        formatOnSave: true,
      },
    }),
  )
  act(() => view.result.current.onEdit(initial.relPath, "draft"))
  let saved: boolean | undefined
  await act(async () => {
    saved = await view.result.current.saveFile(initial.relPath)
  })
  expect(view.result.current.active).toMatchObject({
    content: "draft",
    savedContent: "old",
    baseline: initial.baseline,
    externalChange: true,
  })
  expect(saved).toBe(false)
  expect(view.result.current.error).toMatch(/missing|removed|disappeared/i)
  view.unmount()
})
