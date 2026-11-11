// Live build output through the real `pdf` router, with a FAKE bundled
// compiler: a small shell script stands in for Tectonic, so these tests check
// PI Lab's streaming and download detection, not Tectonic itself (the real
// compiler is covered by pdf.bundled.test.ts and the e2e runs).
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Unsubscribable } from "@trpc/server/observable"
import { afterEach, beforeEach, expect, test } from "vitest"
import { createHarness, type Harness } from "../testHarness"
import type { BuildOutputEvent } from "./pdf"

let h: Harness
let resources: string
let release: string
let workspaceId: string
const subscriptions: Unsubscribable[] = []

/** Poll a predicate until true or the deadline; no fixed sleeps. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("waitFor timed out")
}

beforeEach(async () => {
  resources = await mkdtemp(join(tmpdir(), "pi-lab-fake-tectonic-"))
  release = join(resources, "release")
  const platformDir = join(resources, `${process.platform}-${process.arch}`)
  await mkdir(platformDir)
  // Prints a download note, waits until the test creates the release file,
  // then fills the cache and fails (no PDF is needed for these checks).
  await writeFile(
    join(platformDir, "tectonic"),
    `#!/bin/sh
echo "cache=$TECTONIC_CACHE_DIR"
echo "note: downloading index https://example.invalid/bundle"
while [ ! -e '${release}' ]; do sleep 0.05; done
touch "$TECTONIC_CACHE_DIR/package"
echo "fake compiler finished"
exit 1
`,
    { mode: 0o755 },
  )
  h = await createHarness([], {
    git: false,
    daemon: "lazy",
    latexResourcesDir: resources,
    resolveAgentExecutable: async () => null,
    getAgentLaunchEnvironment: async () => ({ PATH: "/usr/bin:/bin" }),
  })
  const project = await h.caller.projects.open({ path: h.repoDir })
  workspaceId = (await h.caller.workspaces.ensureMain({ projectId: project.id })).id
  await writeFile(
    join(h.repoDir, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\nText.\n\\end{document}\n",
  )
})

afterEach(async () => {
  for (const subscription of subscriptions.splice(0)) subscription.unsubscribe()
  await h.dispose()
  await rm(resources, { recursive: true, force: true })
})

test("build output streams live, reports a first build that downloads TeX packages, and uses the configured cache (fake compiler)", async () => {
  const events: BuildOutputEvent[] = []
  const stream = await h.caller.pdf.onBuildOutput({ workspaceId })
  subscriptions.push(stream.subscribe({ next: (event) => events.push(event) }))

  let settled = false
  const build = h.caller.pdf.build({ workspaceId, relPath: "main.tex" }).finally(() => {
    settled = true
  })
  await waitFor(() => events.some((event) => event.kind === "downloading"), 10_000)
  const start = events.find((event) => event.kind === "start")
  expect(start).toMatchObject({ kind: "start", relPath: "main.tex", firstBuild: true })
  const text = events.map((event) => (event.kind === "chunk" ? event.text : "")).join("")
  expect(text).toContain(`cache=${join(h.dataDir, "latex", "cache")}`)
  expect(text).toContain("note: downloading index")
  // The lines above arrived while the compiler is still running.
  expect(settled).toBe(false)

  await writeFile(release, "")
  const result = await build
  expect(result.log).toContain("fake compiler finished")
  await waitFor(() => events.some((event) => event.kind === "end"), 5_000)
  expect(new Set(events.map((event) => event.buildId)).size).toBe(1)

  // The cache now holds a package, so the next build is not a first build.
  expect(existsSync(join(h.dataDir, "latex", "cache", "package"))).toBe(true)
  events.length = 0
  await h.caller.pdf.build({ workspaceId, relPath: "main.tex" })
  await waitFor(() => events.some((event) => event.kind === "end"), 5_000)
  expect(events.find((event) => event.kind === "start")).toMatchObject({ firstBuild: false })
})
