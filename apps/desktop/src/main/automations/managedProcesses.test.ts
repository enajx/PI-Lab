import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DaemonClient, DaemonServer } from "@pi-lab/pty-daemon"
import { expect, test, vi } from "vitest"
import { ManagedProcesses } from "./managedProcesses"

test("real daemon preserves a background process across owner disposal and restores its outcome", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-managed-"))
  const socketPath = join(dir, "socket")
  const server = new DaemonServer({ socketPath })
  await server.listen()
  const first = new DaemonClient(socketPath)
  const second = new DaemonClient(socketPath)
  await first.connect()
  let manager = new ManagedProcesses(join(dir, "owners"), async () => first)
  try {
    const started = await manager.run({
      command: process.execPath,
      args: ["-e", "setTimeout(()=>{console.log('durable result')},400)"],
      cwd: dir,
      metadata: { kind: "fixture" },
    })
    manager.dispose()
    first.close()
    await second.connect()
    manager = new ManagedProcesses(join(dir, "owners"), async () => second)
    let restored!: Promise<void>
    await manager.recover((metadata, process) => {
      expect(metadata.kind).toBe("fixture")
      expect(process.processId).toBe(started.processId)
      restored = process.completion.then(async (result) => {
        expect(result).toMatchObject({ code: 0, error: null, stdout: "durable result\n" })
        if (!process.processId) throw new Error("Missing recovered process ID")
        // Model a successful forget whose reply was lost before the owner file was removed.
        await second.forgetProcess(process.processId)
        await process.acknowledge?.()
      })
    })
    await restored
    expect(await second.listProcesses()).toEqual([])
  } finally {
    manager.dispose()
    first.close()
    second.close()
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("reconnect replays missed Unicode output exactly once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-managed-replay-"))
  const server = new DaemonServer({ socketPath: join(dir, "socket") })
  await server.listen()
  const first = new DaemonClient(join(dir, "socket"))
  const second = new DaemonClient(join(dir, "socket"))
  await first.connect()
  await second.connect()
  let active = first
  let output = ""
  const manager = new ManagedProcesses(join(dir, "owners"), async () => active)
  const waitFor = async (predicate: () => boolean | Promise<boolean>) => {
    const end = Date.now() + 4000
    while (Date.now() < end) {
      if (await predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error("managed replay deadline")
  }
  try {
    const started = await manager.run({
      command: process.execPath,
      args: [
        "-e",
        "const fs=require('node:fs');process.stdout.write('α');let sent=false;setInterval(()=>{if(!sent&&fs.existsSync('next')){sent=true;process.stdout.write('β')}},10)",
      ],
      cwd: dir,
      metadata: { kind: "fixture" },
      onOutput: (chunk) => {
        output += chunk
      },
    })
    const processId = started.processId
    if (!processId) throw new Error("Missing daemon process ID")
    await waitFor(() => output === "α")
    first.close()
    await writeFile(join(dir, "next"), "")
    await waitFor(async () => (await second.attachProcess(processId)).stdout === "αβ")
    active = second
    await waitFor(() => output === "αβ")
    expect(output).toBe("αβ")
    await second.killProcess(processId)
    const result = await started.completion
    expect(result.stdout).toBe("αβ")
    await started.acknowledge?.()
  } finally {
    manager.dispose()
    first.close()
    second.close()
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("stop and running count include only jobs owned by this manager", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-managed-owner-"))
  const server = new DaemonServer({ socketPath: join(dir, "socket") })
  await server.listen()
  const client = new DaemonClient(join(dir, "socket"))
  await client.connect()
  const manager = new ManagedProcesses(join(dir, "owners"), async () => client)
  try {
    const foreign = await client.startProcess({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},100)"],
      cwd: dir,
      env: {},
      metadata: { ownerId: "another-owner" },
    })
    const own = await manager.run({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},100)"],
      cwd: dir,
      metadata: { kind: "fixture" },
    })
    expect(await manager.runningCount()).toBe(1)
    const persisted = own.completion.then(async (result) => {
      expect(result.signal).toBe("SIGKILL")
      await own.acknowledge?.()
    })
    await manager.stopAll()
    await persisted
    expect((await client.listProcesses()).find((job) => job.id === foreign.id)?.alive).toBe(true)
  } finally {
    manager.dispose()
    client.close()
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("failed spawn removes its owner; a lost spawn reply adopts the actual daemon job", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-managed-spawn-"))
  const server = new DaemonServer({ socketPath: join(dir, "socket") })
  await server.listen()
  const client = new DaemonClient(join(dir, "socket"))
  await client.connect()
  const manager = new ManagedProcesses(join(dir, "owners"), async () => client)
  try {
    await expect(
      manager.run({
        command: "/missing/pi-lab-agent",
        args: [],
        cwd: dir,
      }),
    ).rejects.toThrow()
    expect(await readdir(join(dir, "owners"))).toEqual([])
    await manager.stopAll()
    const start = client.startProcess.bind(client)
    vi.spyOn(client, "startProcess").mockImplementationOnce(async (params) => {
      await start(params)
      throw new Error("spawn reply lost")
    })
    const adopted = await manager.run({
      command: process.execPath,
      args: ["-e", "console.log('adopted')"],
      cwd: dir,
    })
    expect((await adopted.completion).stdout).toBe("adopted\n")
    expect(await client.listProcesses()).toHaveLength(1)
    await adopted.acknowledge?.()
    expect(await readdir(join(dir, "owners"))).toEqual([])

    const list = client.listProcesses.bind(client)
    vi.spyOn(client, "listProcesses")
      .mockImplementationOnce(list)
      .mockRejectedValueOnce(new Error("connection still unavailable"))
    vi.mocked(client.startProcess).mockImplementationOnce(async (params) => {
      await start(params)
      throw new Error("another spawn reply lost")
    })
    await expect(
      manager.run({
        command: process.execPath,
        args: ["-e", "console.log('recover later');setInterval(()=>{},100)"],
        cwd: dir,
      }),
    ).rejects.toThrow("connection still unavailable")
    expect(await readdir(join(dir, "owners"))).toHaveLength(1)
    expect(await list()).toHaveLength(1)
    let recovered!: Promise<void>
    const restore = vi.fn(
      (
        _metadata: Record<string, string>,
        process: import("./nonInteractiveRunner").StartedNonInteractiveProcess,
      ) => {
        recovered = process.completion.then(async (result) => {
          expect(result.signal).toBe("SIGKILL")
          await process.acknowledge?.()
        })
      },
    )
    // The quit preparation can recover without reopening or double-registering.
    await manager.recover(restore)
    await manager.recover(restore)
    await manager.stopAll()
    await recovered
    expect(restore).toHaveBeenCalledTimes(1)
    expect(await readdir(join(dir, "owners"))).toEqual([])

    // A directory entry whose target disappeared exercises the same ENOENT as
    // an acknowledgement unlinking an owner between readdir and readFile.
    await symlink(join(dir, "removed-owner"), join(dir, "owners", "vanished.json"))
    expect(await manager.runningCount()).toBe(0)
  } finally {
    manager.dispose()
    client.close()
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
