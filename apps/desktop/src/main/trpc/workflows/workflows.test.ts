// Integration tests for the background project workflows (plan "Project cards /
// panels / settings"): createCaller over a temp SQLite DB with real migrations,
// a real temp git repo, and a mocked non-interactive runner so the git-state
// cache, re-run trigger, error recording, persistence, and the live-output
// subscription are exercised without spawning a real agent.
//
// `workflows.run` now starts the headless agent in the background and returns
// immediately (running=true); the run finishes asynchronously (persisting the
// record + emitting a terminal stream event). Tests therefore start a run and
// then wait for it to settle via `status`.
import { existsSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projects, projectWorkflowRuns, type WorkflowTask } from "@pi-lab/local-db"
import type { TerminalAgent } from "@pi-lab/shared"
import type { Unsubscribable } from "@trpc/server/observable"
import { and, eq } from "drizzle-orm"
import { describe, expect, test } from "vitest"
import type {
  NonInteractiveProcessInput,
  NonInteractiveProcessResult,
  NonInteractiveProcessRunner,
} from "../../automations/nonInteractiveRunner"
import { computeGitStateHash } from "../../git"
import { createHarness, type Harness } from "../testHarness"
import type { ProjectWorkflowRecord, WorkflowOutputEvent } from "./workflows"

// A non-interactive-capable agent (buildNonInteractiveLaunchArgv supports codex).
const CODEX_AGENT: TerminalAgent = {
  id: "codex",
  label: "Codex",
  command: "/custom/codex",
  detect: "codex",
  defaultArgs: ["--profile", "science"],
  env: { AGENT_ENV: "kept" },
}

// Claude runs in streaming-JSON mode: the workflow layer appends the stream-json
// flags and parses its JSON lines into live activity + a separate final report.
const CLAUDE_AGENT: TerminalAgent = {
  id: "claude-code",
  label: "Claude Code",
  command: "/custom/claude",
  detect: "claude",
  defaultArgs: ["--dangerously-skip-permissions"],
}

/** Serialise events as newline-terminated JSON lines, as Claude prints them. */
function claudeTranscript(events: unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
}

interface RunnerHooks {
  /** Chunks emitted (synchronously) via `onOutput` when the process is started. */
  chunks?: (call: number) => Array<[string, "stdout" | "stderr"]>
  /** Override the completion promise (e.g. a gate that resolves later). */
  completion?: (call: number) => Promise<NonInteractiveProcessResult>
}

/** A counting runner producing a caller-provided result for each invocation. */
function makeRunner(result: (call: number) => NonInteractiveProcessResult, hooks?: RunnerHooks) {
  const calls: NonInteractiveProcessInput[] = []
  const runner: NonInteractiveProcessRunner = async (input) => {
    calls.push(input)
    const n = calls.length
    for (const [text, stream] of hooks?.chunks?.(n) ?? []) input.onOutput?.(text, stream)
    return { completion: hooks?.completion?.(n) ?? Promise.resolve(result(n)) }
  }
  return { calls, runner }
}

const ok = (stdout: string): NonInteractiveProcessResult => ({
  code: 0,
  signal: null,
  error: null,
  stdout,
  stderr: "",
})

/** Poll a predicate until true or the deadline; deterministic, no fixed sleeps. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("waitFor timed out")
}

async function recordFor(
  harness: Harness,
  projectId: string,
  task: WorkflowTask,
): Promise<ProjectWorkflowRecord | null> {
  const status = await harness.caller.workflows.status({ projectId })
  return task === "summary"
    ? status.summary
    : task === "plan-research"
      ? status.planResearch
      : status.fetchExperiments
}

/** Wait until the (project, task) run is no longer in flight, returning its record. */
async function settle(
  harness: Harness,
  projectId: string,
  task: WorkflowTask,
): Promise<ProjectWorkflowRecord> {
  await waitFor(async () => {
    const record = await recordFor(harness, projectId, task)
    return record !== null && !record.running
  })
  const record = await recordFor(harness, projectId, task)
  if (!record) throw new Error("expected a settled record")
  return record
}

async function openProject(runner: NonInteractiveProcessRunner) {
  const harness = await createHarness([CODEX_AGENT], { runNonInteractiveProcess: runner })
  const project = await harness.caller.projects.open({ path: harness.repoDir })
  await harness.caller.agents.setProjectChoice({ projectId: project.id, agentId: "codex" })
  return { harness, projectId: project.id }
}

async function openClaudeProject(runner: NonInteractiveProcessRunner) {
  const harness = await createHarness([CLAUDE_AGENT], { runNonInteractiveProcess: runner })
  const project = await harness.caller.projects.open({ path: harness.repoDir })
  await harness.caller.agents.setProjectChoice({ projectId: project.id, agentId: "claude-code" })
  return { harness, projectId: project.id }
}

describe("workflows.run — Git precondition", () => {
  test("rejects a non-Git folder before launching its headless agent", async () => {
    const { calls, runner } = makeRunner(() => ok("must not run"))
    const harness = await createHarness([CODEX_AGENT], { runNonInteractiveProcess: runner })
    const plain = await mkdtemp(join(tmpdir(), "pi-lab-plain-workflow-"))
    const project = await harness.caller.projects.open({ path: plain })

    try {
      await expect(
        harness.caller.workflows.run({ projectId: project.id, task: "summary" }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: expect.stringContaining("Initialize Git"),
      })
      expect(calls).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })
})

describe("workflows.run — git-state cache + re-run", () => {
  test("caches while git state is unchanged, re-runs when it changes", async () => {
    const { calls, runner } = makeRunner((n) => ok(`summary ${n}`))
    const { harness, projectId } = await openProject(runner)
    try {
      // First run starts a background execution (running, not cached).
      const first = await harness.caller.workflows.run({ projectId, task: "summary" })
      expect(first.cached).toBe(false)
      expect(first.running).toBe(true)
      const firstRecord = await settle(harness, projectId, "summary")
      expect(firstRecord.result).toBe("summary 1")
      expect(calls).toHaveLength(1)

      // The prompt still targets RESEARCH.md's "## Status" section, in the repo cwd.
      const prompt = calls[0]?.args.at(-1) ?? ""
      expect(prompt).toContain("RESEARCH.md")
      expect(prompt).toContain("## Status")
      expect(calls[0]?.cwd).toBe(harness.repoDir)
      expect(calls[0]?.env).toMatchObject({ AGENT_ENV: "kept" })

      // Second run with an unchanged repo serves the cache — no new process.
      const second = await harness.caller.workflows.run({ projectId, task: "summary" })
      expect(second.cached).toBe(true)
      expect(second.result).toBe("summary 1")
      expect(calls).toHaveLength(1)

      // A working-tree change flips the git-state hash → re-run.
      writeFileSync(join(harness.repoDir, "new-artifact.txt"), "hello", "utf8")
      const third = await harness.caller.workflows.run({ projectId, task: "summary" })
      expect(third.cached).toBe(false)
      const thirdRecord = await settle(harness, projectId, "summary")
      expect(thirdRecord.result).toBe("summary 2")
      expect(calls).toHaveLength(2)
    } finally {
      await harness.dispose()
    }
  })

  test("force re-runs even when the git state is unchanged", async () => {
    const { calls, runner } = makeRunner((n) => ok(`summary ${n}`))
    const { harness, projectId } = await openProject(runner)
    try {
      await harness.caller.workflows.run({ projectId, task: "summary" })
      await settle(harness, projectId, "summary")
      const forced = await harness.caller.workflows.run({ projectId, task: "summary", force: true })
      expect(forced.cached).toBe(false)
      const forcedRecord = await settle(harness, projectId, "summary")
      expect(forcedRecord.result).toBe("summary 2")
      expect(calls).toHaveLength(2)
    } finally {
      await harness.dispose()
    }
  })

  test("acknowledges a completed workflow whose project was removed by an older app", async () => {
    let release!: (result: NonInteractiveProcessResult) => void
    let started = false
    let acknowledged = false
    const completion = new Promise<NonInteractiveProcessResult>((resolve) => {
      release = resolve
    })
    const { harness, projectId } = await openProject(async () => {
      started = true
      return {
        completion,
        acknowledge: async () => {
          acknowledged = true
        },
      }
    })
    try {
      await harness.caller.workflows.run({ projectId, task: "summary" })
      await waitFor(() => started)
      // Simulate a pre-fix deletion; the public removal route now blocks this.
      harness.db.delete(projects).where(eq(projects.id, projectId)).run()
      release(ok("finished"))
      await waitFor(() => acknowledged)
    } finally {
      release(ok("cleanup"))
      await harness.dispose()
    }
  })

  test("project removal waits for an in-flight workflow to save its result", async () => {
    let release!: (result: NonInteractiveProcessResult) => void
    const completion = new Promise<NonInteractiveProcessResult>((resolve) => {
      release = resolve
    })
    const { runner } = makeRunner(() => ok("unused"), { completion: () => completion })
    const { harness, projectId } = await openProject(runner)
    try {
      await harness.caller.workflows.run({ projectId, task: "summary" })
      await expect(harness.caller.projects.remove({ id: projectId })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      })
      release(ok("saved result"))
      expect((await settle(harness, projectId, "summary")).result).toBe("saved result")
      await harness.caller.projects.remove({ id: projectId })
      expect(await harness.caller.projects.list()).toHaveLength(0)
    } finally {
      release(ok("cleanup"))
      await harness.dispose()
    }
  })

  test("run returns immediately without awaiting the agent's completion", async () => {
    // The process never completes — yet `run` must resolve promptly with the
    // running record, proving the mutation does not block on the agent.
    const { runner } = makeRunner(() => ok("never"), {
      completion: () => new Promise<NonInteractiveProcessResult>(() => {}),
    })
    const { harness, projectId } = await openProject(runner)
    try {
      const started = await Promise.race([
        harness.caller.workflows.run({ projectId, task: "summary" }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("run did not return promptly")), 1500),
        ),
      ])
      expect(started.running).toBe(true)
      expect(started.cached).toBe(false)
      expect(started.result).toBe("")

      // status still reflects the in-flight run.
      const record = await recordFor(harness, projectId, "summary")
      expect(record?.running).toBe(true)
    } finally {
      await harness.dispose()
    }
  })
})

describe("workflows.onOutput — live streaming", () => {
  test("replays buffered output, streams new chunks, and ends with a done event", async () => {
    // Gate the completion so the run stays in flight while we subscribe.
    let releaseCompletion: (result: NonInteractiveProcessResult) => void = () => {}
    const gate = new Promise<NonInteractiveProcessResult>((resolve) => {
      releaseCompletion = resolve
    })
    const { calls, runner } = makeRunner(() => ok("unused"), {
      // One chunk is printed up front (buffered before we subscribe).
      chunks: () => [["hello ", "stdout"]],
      completion: () => gate,
    })
    const { harness, projectId } = await openProject(runner)
    const subscriptions: Unsubscribable[] = []
    try {
      await harness.caller.workflows.run({ projectId, task: "summary" })
      // Wait until the process has actually started (and buffered its first chunk).
      await waitFor(() => calls.length === 1)

      const events: WorkflowOutputEvent[] = []
      const observableLike = await harness.caller.workflows.onOutput({ projectId, task: "summary" })
      subscriptions.push(observableLike.subscribe({ next: (event) => events.push(event) }))

      // Replay: the command line + the pre-subscription chunk are delivered.
      await waitFor(() => events.some((e) => e.kind === "chunk" && e.text === "hello "))
      expect(events.some((e) => e.kind === "start")).toBe(true)

      // A live chunk printed after we subscribed is streamed.
      calls[0]?.onOutput?.("world", "stdout")
      await waitFor(() => events.some((e) => e.kind === "chunk" && e.text === "world"))

      // Completing the run emits the terminal done event with the trimmed result.
      releaseCompletion(ok("  Photon summary.  "))
      await waitFor(() => events.some((e) => e.kind === "done"))
      expect(events.find((e) => e.kind === "done")).toEqual({
        kind: "done",
        result: "Photon summary.",
      })
    } finally {
      for (const sub of subscriptions) sub.unsubscribe()
      await harness.dispose()
    }
  })

  test("emits an error terminal event when the run fails", async () => {
    const { runner } = makeRunner((n) =>
      n === 1
        ? { code: 3, signal: null, error: null, stdout: "", stderr: "model unavailable" }
        : ok("unused"),
    )
    const { harness, projectId } = await openProject(runner)
    const subscriptions: Unsubscribable[] = []
    try {
      await harness.caller.workflows.run({ projectId, task: "summary" })
      // The run is fast; the stream is retained after completion, so a late
      // subscriber still replays it and receives the terminal error event.
      await settle(harness, projectId, "summary")

      const events: WorkflowOutputEvent[] = []
      const observableLike = await harness.caller.workflows.onOutput({ projectId, task: "summary" })
      subscriptions.push(observableLike.subscribe({ next: (event) => events.push(event) }))

      await waitFor(() => events.some((e) => e.kind === "error"))
      const error = events.find((e) => e.kind === "error")
      expect(error?.kind).toBe("error")
      if (error?.kind === "error") expect(error.message).toMatch(/code 3.*model unavailable/i)
    } finally {
      for (const sub of subscriptions) sub.unsubscribe()
      await harness.dispose()
    }
  })

  test("attaches to a run that starts AFTER subscribe (the click race — no missed output)", async () => {
    // The dialog subscribes the instant the control is clicked, while
    // `workflows.run` is still `await`ing the git-state hash — so no stream
    // exists yet at subscribe time. The subscription must WAIT for the run to
    // start and then stream it, not complete empty and miss the whole run (the
    // "No output was captured" bug).
    const { runner } = makeRunner(() => ok("final report"), {
      chunks: () => [["step one\n", "stdout"]],
    })
    const { harness, projectId } = await openProject(runner)
    const subscriptions: Unsubscribable[] = []
    try {
      const events: WorkflowOutputEvent[] = []
      let completed = false
      const observableLike = await harness.caller.workflows.onOutput({
        projectId,
        task: "fetch-experiments",
      })
      subscriptions.push(
        observableLike.subscribe({
          next: (event) => events.push(event),
          complete: () => {
            completed = true
          },
        }),
      )
      // Subscribed before any run — it must be waiting, NOT already completed.
      expect(completed).toBe(false)

      // Now start the run; the waiting subscription must attach and stream it.
      await harness.caller.workflows.run({ projectId, task: "fetch-experiments" })
      await waitFor(() => completed)
      expect(events.some((event) => event.kind === "start")).toBe(true)
      expect(
        events.some((event) => event.kind === "chunk" && event.text.includes("step one")),
      ).toBe(true)
      expect(events.some((event) => event.kind === "done")).toBe(true)
    } finally {
      for (const sub of subscriptions) sub.unsubscribe()
      await harness.dispose()
    }
  })
})

describe("workflows.run — Claude stream-json parsing", () => {
  const TRANSCRIPT = claudeTranscript([
    { type: "system", subtype: "init", model: "claude-sonnet-5", tools: [], cwd: "/repo" },
    { type: "system", subtype: "hook_started", hook: "PreToolUse" }, // noise
    {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read", input: { file_path: "/repo/train.py" } }],
      },
    },
    {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Edit", input: { file_path: "/repo/RESEARCH.md" } }],
      },
    },
    { type: "rate_limit_event", tier: "default" }, // noise
    { type: "result", subtype: "success", is_error: false, result: "  Photon drift on track.  " },
  ])

  test("runs Claude in stream-json mode; activity = live steps, report = the .result", async () => {
    const { calls, runner } = makeRunner(() => ok("ignored-stdout"), {
      // Claude prints its JSON lines to stdout as it works.
      chunks: () => [[TRANSCRIPT, "stdout"]],
    })
    const { harness, projectId } = await openClaudeProject(runner)
    const subscriptions: Unsubscribable[] = []
    try {
      await harness.caller.workflows.run({ projectId, task: "summary" })
      const record = await settle(harness, projectId, "summary")

      // The report is the parsed `.result` string (trimmed) — NOT the raw JSON.
      expect(record.result).toBe("Photon drift on track.")
      expect(record.result).not.toContain("{")

      // Both stream-json flags are passed (required together).
      const args = calls[0]?.args ?? []
      expect(args).toContain("--output-format")
      expect(args).toContain("stream-json")
      expect(args).toContain("--verbose")

      // The activity log is the readable live steps, DIFFERENT from the report and
      // free of raw JSON; noise events (hooks / rate-limit) are dropped.
      const events: WorkflowOutputEvent[] = []
      const observableLike = await harness.caller.workflows.onOutput({ projectId, task: "summary" })
      subscriptions.push(observableLike.subscribe({ next: (event) => events.push(event) }))
      await waitFor(() => events.some((e) => e.kind === "done"))

      const activity = events
        .filter((e): e is Extract<WorkflowOutputEvent, { kind: "chunk" }> => e.kind === "chunk")
        .map((e) => e.text)
        .join("")
      expect(activity).toContain("▶ claude-sonnet-5")
      expect(activity).toContain("→ Read train.py")
      expect(activity).toContain("→ Edit RESEARCH.md")
      expect(activity).not.toContain("{")
      expect(activity).not.toContain("hook_started")
      // The report text is not duplicated into the activity log.
      expect(activity).not.toContain("Photon drift on track.")

      // The terminal done event carries the report (the persisted result).
      const done = events.find((e) => e.kind === "done")
      expect(done).toEqual({ kind: "done", result: "Photon drift on track." })
    } finally {
      for (const sub of subscriptions) sub.unsubscribe()
      await harness.dispose()
    }
  })

  test("an is_error result is recorded as a failure (never a silent bad summary)", async () => {
    const errorTranscript = claudeTranscript([
      { type: "system", subtype: "init", model: "m" },
      { type: "result", subtype: "error", is_error: true, result: "model unavailable" },
    ])
    const { runner } = makeRunner(() => ok(""), { chunks: () => [[errorTranscript, "stdout"]] })
    const { harness, projectId } = await openClaudeProject(runner)
    try {
      await harness.caller.workflows.run({ projectId, task: "summary" })
      const record = await settle(harness, projectId, "summary")
      expect(record.errorMessage).toContain("model unavailable")
      expect(record.result).toBe("")
    } finally {
      await harness.dispose()
    }
  })
})

describe("workflows.run — persistence + status", () => {
  test("persists result, git-state hash, and last-checked, and status reads it back", async () => {
    const { runner } = makeRunner(() => ok("  Photon drift on track.  \n"))
    const { harness, projectId } = await openProject(runner)
    try {
      const before = Date.now()
      await harness.caller.workflows.run({ projectId, task: "summary" })
      const record = await settle(harness, projectId, "summary")
      expect(record.result).toBe("Photon drift on track.")

      // The row carries the trimmed result, the current git-state hash, a real
      // timestamp, and no error.
      const expectedHash = await computeGitStateHash(harness.repoDir)
      const row = harness.db
        .select()
        .from(projectWorkflowRuns)
        .where(
          and(
            eq(projectWorkflowRuns.projectId, projectId),
            eq(projectWorkflowRuns.task, "summary"),
          ),
        )
        .get()
      expect(row?.result).toBe("Photon drift on track.")
      expect(row?.inputHash).toBe(expectedHash)
      expect(row?.errorMessage).toBeNull()
      expect(row?.lastCheckedAt ?? 0).toBeGreaterThanOrEqual(before)

      // status surfaces the summary record and a null fetch-experiments record.
      const status = await harness.caller.workflows.status({ projectId })
      expect(status.summary).toMatchObject({
        running: false,
        result: "Photon drift on track.",
        inputHash: expectedHash,
        errorMessage: null,
      })
      expect(status.fetchExperiments).toBeNull()
    } finally {
      await harness.dispose()
    }
  })

  test("a fresh project reports null for all tasks", async () => {
    const { runner } = makeRunner(() => ok("unused"))
    const { harness, projectId } = await openProject(runner)
    try {
      const status = await harness.caller.workflows.status({ projectId })
      expect(status).toEqual({ summary: null, fetchExperiments: null, planResearch: null })
    } finally {
      await harness.dispose()
    }
  })
})

describe("workflows.run — failures surface as an error record", () => {
  test("a non-zero exit records the failure and forces the next run", async () => {
    const { calls, runner } = makeRunner((n) =>
      n === 1
        ? { code: 3, signal: null, error: null, stdout: "", stderr: "model unavailable" }
        : ok("recovered"),
    )
    const { harness, projectId } = await openProject(runner)
    try {
      await harness.caller.workflows.run({ projectId, task: "summary" })
      const failed = await settle(harness, projectId, "summary")
      expect(failed.errorMessage).toMatch(/code 3.*model unavailable/i)
      expect(failed.result).toBe("")

      // status reflects the error; the record is not treated as a valid cache, so
      // the next run re-executes despite the unchanged git state.
      const status = await harness.caller.workflows.status({ projectId })
      expect(status.summary?.errorMessage).toMatch(/code 3/i)

      const retry = await harness.caller.workflows.run({ projectId, task: "summary" })
      expect(retry.cached).toBe(false)
      const retryRecord = await settle(harness, projectId, "summary")
      expect(retryRecord.errorMessage).toBeNull()
      expect(retryRecord.result).toBe("recovered")
      expect(calls).toHaveLength(2)
    } finally {
      await harness.dispose()
    }
  })

  test("a timeout is recorded as an error (never a silent hang)", async () => {
    const { runner } = makeRunner(() => ({
      code: null,
      signal: "SIGKILL",
      error: "Timed out after 180000ms",
      stdout: "",
      stderr: "",
    }))
    const { harness, projectId } = await openProject(runner)
    try {
      await harness.caller.workflows.run({ projectId, task: "summary" })
      const record = await settle(harness, projectId, "summary")
      expect(record.errorMessage).toMatch(/timed out/i)
    } finally {
      await harness.dispose()
    }
  })
})

describe("workflows.run — fetch-experiments task", () => {
  test("scaffolds the fetch-experiments SKILL.md and returns the printed summary", async () => {
    const { calls, runner } = makeRunner(() => ok("Fetched 3 runs into results/."))
    const { harness, projectId } = await openProject(runner)
    const skillPath = join(harness.repoDir, ".claude", "skills", "fetch-experiments", "SKILL.md")
    try {
      expect(existsSync(skillPath)).toBe(false)

      await harness.caller.workflows.run({ projectId, task: "fetch-experiments" })
      const record = await settle(harness, projectId, "fetch-experiments")
      expect(record.result).toBe("Fetched 3 runs into results/.")

      // The placeholder skill is scaffolded, and the prompt runs it.
      expect(existsSync(skillPath)).toBe(true)
      const prompt = calls[0]?.args.at(-1) ?? ""
      expect(prompt).toContain("fetch-experiments skill")
    } finally {
      await harness.dispose()
    }
  })
})

describe("Plan research skill", () => {
  test("missing skill becomes a visible error without launching an agent, including without Git", async () => {
    const { calls, runner } = makeRunner(() => ok("must not run"))
    const harness = await createHarness([CODEX_AGENT], {
      runNonInteractiveProcess: runner,
      git: false,
    })
    try {
      const project = await harness.caller.projects.open({ path: harness.repoDir })
      await harness.caller.workflows.run({ projectId: project.id, task: "plan-research" })
      const record = await settle(harness, project.id, "plan-research")
      expect(record.errorMessage).toContain("Plan research skill could not be found")
      expect(calls).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })

  test("invokes a user-installed skill and retries after the skill changes", async () => {
    const { calls, runner } = makeRunner(() => ok("Research plan ready"))
    const { harness, projectId } = await openProject(runner)
    try {
      const directory = join(harness.skillsHomeDir, ".agents", "skills", "plan-research")
      await mkdir(directory, { recursive: true })
      const path = join(directory, "SKILL.md")
      await writeFile(path, "---\nname: plan-research\n---\nAsk about the scientific question.\n")
      await harness.caller.workflows.run({ projectId, task: "plan-research" })
      expect((await settle(harness, projectId, "plan-research")).result).toBe("Research plan ready")
      expect(calls[0]?.args.join(" ")).toContain(path)
      await writeFile(path, "Revised research instructions")
      await harness.caller.workflows.run({ projectId, task: "plan-research" })
      await settle(harness, projectId, "plan-research")
      expect(calls).toHaveLength(2)
    } finally {
      await harness.dispose()
    }
  })
})
