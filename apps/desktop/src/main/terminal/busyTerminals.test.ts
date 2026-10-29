import type { SessionInfo } from "@pi-lab/pty-daemon"
import { expect, test } from "vitest"
import { busyTerminals } from "./busyTerminals"

function session(id: string, fields: Partial<SessionInfo>): SessionInfo {
  return {
    id,
    command: "/bin/zsh",
    args: [],
    cwd: "/work/alpha",
    cols: 80,
    rows: 24,
    createdAt: 0,
    pid: 100,
    alive: true,
    foregroundProcess: "zsh",
    ...fields,
  }
}

const roots = [
  { project: "Alpha", path: "/work/alpha" },
  { project: "Alpha", path: "/worktrees/alpha-feature" },
  { project: "Nested", path: "/work/alpha/nested" },
]

test("idle shells, agents and exited sessions are not listed", () => {
  const sessions = [
    session("idle-zsh", {}),
    // macOS reports `bash` for /bin/sh; Linux may report an argv path.
    session("idle-sh", { command: "/bin/sh", foregroundProcess: "bash" }),
    session("idle-path", { command: "/bin/bash", foregroundProcess: "/bin/bash" }),
    session("agent", { command: "/usr/local/bin/claude", foregroundProcess: "claude" }),
    session("exited", { foregroundProcess: null, alive: false, pid: null }),
  ]
  expect(busyTerminals(sessions, new Set(["agent"]), roots)).toEqual([])
})

test("a shell running a command is listed with its project and command", () => {
  const sessions = [
    session("busy", { cwd: "/work/alpha/src", foregroundProcess: "sleep" }),
    session("worktree", { cwd: "/worktrees/alpha-feature", foregroundProcess: "/usr/bin/make" }),
    session("nested", { cwd: "/work/alpha/nested", foregroundProcess: "node" }),
    session("outside", { cwd: "/tmp/scratch", foregroundProcess: "top" }),
  ]
  expect(busyTerminals(sessions, new Set(), roots)).toEqual([
    { project: "Alpha", command: "sleep" },
    { project: "Alpha", command: "make" },
    { project: "Nested", command: "node" },
    { project: "/tmp/scratch", command: "top" },
  ])
})

test("a Python run counts as busy for as long as it is alive", () => {
  const sessions = [
    session("python", {
      command: "/work/alpha/.venv/bin/python",
      args: ["train.py"],
      foregroundProcess: "python",
    }),
  ]
  expect(busyTerminals(sessions, new Set(), roots)).toEqual([
    { project: "Alpha", command: "python" },
  ])
})

test("a shell whose foreground process is unknown (older daemon) is listed", () => {
  const legacy = session("legacy", {})
  delete legacy.foregroundProcess
  expect(busyTerminals([legacy], new Set(), roots)).toEqual([{ project: "Alpha", command: "zsh" }])
})
