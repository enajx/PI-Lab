// Integration tests for the science.cluster router via createCallerFactory over
// a temp SQLite DB with the real migrations (AGENTS.md §14). The ssh probe is the
// injected fake (FAKE_SSH_EXEC) so `refreshStatus` never touches the network.
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import type { SshExec } from "../../../lib/ssh-config"
import { createHarness, FAKE_AGENT, type Harness } from "../../testHarness"

const SSH_CONFIG_FIXTURE = `
Host gpu-box
  HostName 10.0.0.5
  User researcher
  Port 2222

Host laptop
  HostName laptop.local
  User ada

Host *
  ServerAliveInterval 60
`

let h: Harness
let fixtureDir: string
let fixturePath: string

beforeEach(async () => {
  h = await createHarness()
  fixtureDir = await mkdtemp(join(tmpdir(), "skipper-ssh-"))
  fixturePath = join(fixtureDir, "config")
  await writeFile(fixturePath, SSH_CONFIG_FIXTURE)
})

afterEach(async () => {
  await h.dispose()
  await rm(fixtureDir, { recursive: true, force: true })
})

describe("science.cluster.importFromSshConfig", () => {
  test("imports concrete hosts (wildcards skipped) into machines", async () => {
    const { imported } = await h.caller.science.cluster.importFromSshConfig({ path: fixturePath })
    expect(imported).toBe(2)

    const { machines } = await h.caller.science.cluster.list()
    expect(machines.map((m) => m.host).sort()).toEqual(["gpu-box", "laptop"])

    const gpu = machines.find((m) => m.host === "gpu-box")
    expect(gpu).toMatchObject({
      hostname: "10.0.0.5",
      user: "researcher",
      port: 2222,
      source: "ssh-config",
      hidden: false,
    })
  })

  test("re-import upserts (no duplicates) and preserves local annotations + hidden", async () => {
    await h.caller.science.cluster.importFromSshConfig({ path: fixturePath })
    const before = await h.caller.science.cluster.list({ includeHidden: true })
    const gpu = before.machines.find((m) => m.host === "gpu-box")
    if (!gpu) throw new Error("gpu-box not imported")

    await h.caller.science.cluster.annotate({ id: gpu.id, label: "Main GPU box" })
    await h.caller.science.cluster.setHidden({ id: gpu.id, hidden: true })

    // Re-import the same config: must not duplicate, and must keep label + hidden.
    await h.caller.science.cluster.importFromSshConfig({ path: fixturePath })
    const after = await h.caller.science.cluster.list({ includeHidden: true })
    expect(after.machines).toHaveLength(2)
    const gpuAfter = after.machines.find((m) => m.host === "gpu-box")
    expect(gpuAfter?.label).toBe("Main GPU box")
    expect(gpuAfter?.hidden).toBe(true)
  })

  test("a missing config path imports nothing (no error)", async () => {
    const { imported } = await h.caller.science.cluster.importFromSshConfig({
      path: join(fixtureDir, "does-not-exist"),
    })
    expect(imported).toBe(0)
  })
})

describe("science.cluster manual machines + annotate + hide", () => {
  test("addMachine stores a manual row; duplicate host is a CONFLICT", async () => {
    const machine = await h.caller.science.cluster.addMachine({
      host: "slurm-head",
      user: "hpc",
      label: "Cluster head node",
    })
    expect(machine).toMatchObject({ host: "slurm-head", user: "hpc", source: "manual" })

    await expect(h.caller.science.cluster.addMachine({ host: "slurm-head" })).rejects.toMatchObject(
      {
        code: "CONFLICT",
      },
    )
  })

  test("annotate sets and clears the label", async () => {
    const m = await h.caller.science.cluster.addMachine({ host: "box" })
    const labeled = await h.caller.science.cluster.annotate({ id: m.id, label: "8×A100" })
    expect(labeled.label).toBe("8×A100")
    const cleared = await h.caller.science.cluster.annotate({ id: m.id, label: null })
    expect(cleared.label).toBeNull()
  })

  test("list hides hidden machines by default but always reports the count", async () => {
    const a = await h.caller.science.cluster.addMachine({ host: "alpha" })
    await h.caller.science.cluster.addMachine({ host: "beta" })
    await h.caller.science.cluster.setHidden({ id: a.id, hidden: true })

    const defaultList = await h.caller.science.cluster.list()
    expect(defaultList.machines.map((m) => m.host)).toEqual(["beta"])
    expect(defaultList.hiddenCount).toBe(1)

    const withHidden = await h.caller.science.cluster.list({ includeHidden: true })
    expect(withHidden.machines.map((m) => m.host)).toEqual(["alpha", "beta"])
    expect(withHidden.hiddenCount).toBe(1)
  })

  test("updateMachine patches only provided fields", async () => {
    const m = await h.caller.science.cluster.addMachine({ host: "box", user: "old" })
    const updated = await h.caller.science.cluster.updateMachine({
      id: m.id,
      user: "new",
      port: 22,
    })
    expect(updated.user).toBe("new")
    expect(updated.port).toBe(22)
    expect(updated.host).toBe("box")
  })
})

describe("science.cluster.refreshStatus (injected fake ssh-exec)", () => {
  test("records reachable: true for a reachable host", async () => {
    const m = await h.caller.science.cluster.addMachine({ host: "up-box" })
    const probed = await h.caller.science.cluster.refreshStatus({ id: m.id })
    expect(probed.reachable).toBe(true)
    expect(probed.statusDetail).toContain("up")
    expect(probed.lastCheckedAt).toBeTypeOf("number")
  })

  test("records reachable: false for an unreachable host (no throw)", async () => {
    const m = await h.caller.science.cluster.addMachine({ host: "down-box" })
    const probed = await h.caller.science.cluster.refreshStatus({ id: m.id })
    expect(probed.reachable).toBe(false)
    expect(probed.statusDetail).toContain("refused")
  })

  test("refreshAll probes every non-hidden machine and skips hidden ones", async () => {
    await h.caller.science.cluster.addMachine({ host: "up-a" })
    await h.caller.science.cluster.addMachine({ host: "down-b" })
    const hidden = await h.caller.science.cluster.addMachine({ host: "up-hidden" })
    await h.caller.science.cluster.setHidden({ id: hidden.id, hidden: true })

    const refreshed = await h.caller.science.cluster.refreshAll()
    expect(refreshed.map((m) => m.host).sort()).toEqual(["down-b", "up-a"])
    expect(refreshed.find((m) => m.host === "up-a")?.reachable).toBe(true)
    expect(refreshed.find((m) => m.host === "down-b")?.reachable).toBe(false)

    // The hidden machine was never probed.
    const all = await h.caller.science.cluster.list({ includeHidden: true })
    expect(all.machines.find((m) => m.host === "up-hidden")?.lastCheckedAt).toBeNull()
  })
})

describe("science.cluster with a custom injected ssh-exec", () => {
  test("uses the harness-provided sshExec, proving full injectability", async () => {
    const calls: string[] = []
    const fakeExec: SshExec = async (host) => {
      calls.push(host)
      return { ok: host === "yes", detail: host }
    }
    const custom = await createHarness([FAKE_AGENT], { sshExec: fakeExec })
    try {
      const yes = await custom.caller.science.cluster.addMachine({ host: "yes" })
      const no = await custom.caller.science.cluster.addMachine({ host: "no" })
      expect((await custom.caller.science.cluster.refreshStatus({ id: yes.id })).reachable).toBe(
        true,
      )
      expect((await custom.caller.science.cluster.refreshStatus({ id: no.id })).reachable).toBe(
        false,
      )
      expect(calls).toEqual(["yes", "no"])
    } finally {
      await custom.dispose()
    }
  })
})
