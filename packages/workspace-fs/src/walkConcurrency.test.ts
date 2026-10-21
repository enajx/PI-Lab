import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({ root: "", active: 0, peak: 0, reads: [] as string[] }))
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      const path = String(args[0])
      state.reads.push(path)
      if (path === state.root) return actual.readdir(...args)
      state.peak = Math.max(state.peak, ++state.active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      try {
        return await actual.readdir(...args)
      } finally {
        state.active--
      }
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      state.peak = Math.max(state.peak, ++state.active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      try {
        return await actual.stat(...args)
      } finally {
        state.active--
      }
    },
  }
})

import { listDir } from "./fs"
import { walkWorkspace } from "./walk"

afterEach(async () => {
  if (state.root) await rm(state.root, { recursive: true, force: true })
  state.root = ""
  state.active = 0
  state.peak = 0
  state.reads = []
})

test("overlaps a bounded number of real directory reads while preserving BFS visit order and stop", async () => {
  state.root = await mkdtemp(join(tmpdir(), "pi-lab-walk-concurrency-"))
  const names = Array.from({ length: 8 }, (_, index) => `d${index}`)
  await Promise.all(
    names.map(async (name) => {
      await mkdir(join(state.root, name))
      await writeFile(join(state.root, name, "artifact.csv"), "x\n1\n")
    }),
  )
  const visited: string[] = []
  await walkWorkspace(state.root, {}, (entry) => {
    visited.push(entry.path)
    return "continue"
  })
  expect(state.peak).toBeGreaterThan(1)
  expect(state.peak).toBeLessThanOrEqual(4)
  expect(visited).toEqual([
    ...names.map((name) => join(state.root, name)),
    ...names.map((name) => join(state.root, name, "artifact.csv")),
  ])

  state.reads = []
  const files: string[] = []
  const stopped = await walkWorkspace(state.root, {}, (entry) => {
    if (entry.kind === "file") {
      files.push(entry.path)
      return "stop"
    }
    return "continue"
  })
  expect(stopped.stopped).toBe(true)
  expect(files).toEqual([join(state.root, "d0", "artifact.csv")])
  expect(state.reads.length).toBeLessThanOrEqual(5) // Root plus at most one bounded prefetch batch.
})

test("lists directory metadata with bounded concurrent stats and stable sorting", async () => {
  state.root = await mkdtemp(join(tmpdir(), "pi-lab-list-concurrency-"))
  const names = Array.from({ length: 8 }, (_, index) => `f${index}.csv`)
  await Promise.all(names.map((name) => writeFile(join(state.root, name), "data")))
  const entries = await listDir(state.root)
  expect(state.peak).toBeGreaterThan(1)
  expect(state.peak).toBeLessThanOrEqual(4)
  expect(entries.map(({ name }) => name)).toEqual(names)
})
