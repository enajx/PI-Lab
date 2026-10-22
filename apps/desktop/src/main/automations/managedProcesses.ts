import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  type DaemonClient,
  DaemonError,
  type ProcessExitEvent,
  type ProcessOutputEvent,
  type ProcessSnapshot,
} from "@pi-lab/pty-daemon"
import { z } from "zod"
import { agentLaunchLifecycle } from "../agents/launchLifecycle"
import type {
  NonInteractiveProcessInput,
  NonInteractiveProcessResult,
  StartedNonInteractiveProcess,
} from "./nonInteractiveRunner"

const ownerSchema = z.object({
  ownerId: z.string().uuid(),
  metadata: z.record(z.string(), z.string()),
})
type Owner = z.infer<typeof ownerSchema>
type Restore = (metadata: Record<string, string>, process: StartedNonInteractiveProcess) => void

/** Main owns lifecycle records; the existing daemon owns pipe processes across app exits. */
export class ManagedProcesses {
  private disposed = false
  private readonly cleanups = new Set<() => void>()
  private readonly claimedOwners = new Set<string>()
  private readonly watches = new Map<string, StartedNonInteractiveProcess>()

  constructor(
    private readonly directory: string,
    private readonly client: () => Promise<DaemonClient>,
  ) {}

  /** Persist an owner before spawn so reconnect can find a lost spawn reply by owner ID. */
  run = (input: NonInteractiveProcessInput): Promise<StartedNonInteractiveProcess> =>
    agentLaunchLifecycle.run(async () => {
      const owner: Owner = {
        ownerId: randomUUID(),
        metadata: input.metadata ?? { kind: "unknown" },
      }
      const client = await this.client()
      // Older daemons ignore job RPCs. Fail the bounded capability check before
      // persisting an owner or sending a request that could start work.
      await client.listProcesses()
      await mkdir(this.directory, { recursive: true })
      await writeFile(this.path(owner), JSON.stringify(owner), { flag: "wx", mode: 0o600 })
      try {
        const process = await client.startProcess({
          command: input.command,
          args: input.args,
          cwd: input.cwd,
          env: input.env ?? {},
          timeoutMs: input.timeoutMs,
          metadata: { ...owner.metadata, ownerId: owner.ownerId },
        })
        return this.watch(owner, process.id, input.onOutput)
      } catch (error) {
        // A missing reply may still mean the daemon started the process.
        // Keep the owner on an unavailable list so recovery cannot lose a live job.
        const jobs = await (await this.client()).listProcesses()
        const spawned = jobs.find((job) => job.metadata.ownerId === owner.ownerId)
        if (spawned) return this.watch(owner, spawned.id, input.onOutput)
        await rm(this.path(owner), { force: true })
        throw error
      }
    })

  /** Reattach persisted owners, including jobs that finished while the app was closed. */
  async recover(restore: Restore): Promise<void> {
    const owners = await this.owners()
    if (owners.length === 0) return
    const client = await this.client()
    const jobs = await client.listProcesses()
    for (const owner of owners) {
      if (this.claimedOwners.has(owner.ownerId)) continue
      const job = jobs.find((entry) => entry.metadata.ownerId === owner.ownerId)
      const process = job
        ? this.watch(owner, job.id, undefined)
        : {
            completion: Promise.resolve({
              code: null,
              signal: null,
              stdout: "",
              stderr: "",
              error: "Agent process was not found after reopening PI Lab",
            }),
            acknowledge: async () => {
              await rm(this.path(owner), { force: true })
              this.claimedOwners.delete(owner.ownerId)
            },
          }
      this.claimedOwners.add(owner.ownerId)
      restore(owner.metadata, process)
    }
  }

  async runningCount(): Promise<number> {
    const owners = new Set((await this.owners()).map((owner) => owner.ownerId))
    if (owners.size === 0) return 0
    return (await (await this.client()).listProcesses()).filter(
      (job) => job.alive && owners.has(job.metadata.ownerId ?? ""),
    ).length
  }

  /** The daemon confirms process-tree termination before each kill resolves. */
  async stopAll(): Promise<void> {
    const owners = new Set((await this.owners()).map((owner) => owner.ownerId))
    if (owners.size === 0) return
    const client = await this.client()
    const jobs = await client.listProcesses()
    await Promise.all(
      jobs
        .filter((job) => job.alive && owners.has(job.metadata.ownerId ?? ""))
        .map((job) => client.killProcess(job.id)),
    )
    const deadline = Date.now() + 5_000
    while ((await this.owners()).length > 0) {
      if (Date.now() >= deadline)
        throw new Error("Background agent results have not been saved; quit was cancelled")
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  dispose(): void {
    this.disposed = true
    for (const cleanup of [...this.cleanups]) cleanup()
  }

  private path(owner: Owner): string {
    return join(this.directory, `${owner.ownerId}.json`)
  }

  private async owners(): Promise<Owner[]> {
    const files = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
    const owners = await Promise.all(
      files
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const raw = await readFile(join(this.directory, name), "utf8").catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null
              throw error
            },
          )
          return raw === null ? null : ownerSchema.parse(JSON.parse(raw))
        }),
    )
    return owners.filter((owner): owner is Owner => owner !== null)
  }

  private watch(
    owner: Owner,
    id: string,
    output: NonInteractiveProcessInput["onOutput"],
  ): StartedNonInteractiveProcess {
    const existing = this.watches.get(id)
    if (existing) return existing
    this.claimedOwners.add(owner.ownerId)
    let sequence = -1
    const consumed = { stdout: 0, stderr: 0 }
    let settled = false
    let resolve!: (result: NonInteractiveProcessResult) => void
    let disconnect = () => {}
    let retry: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      disconnect()
      clearTimeout(retry)
      this.cleanups.delete(cleanup)
    }
    const complete = (result: ProcessSnapshot["result"]) => {
      if (!result || settled || this.disposed) return
      settled = true
      cleanup()
      resolve({ ...result, signal: result.signal as NodeJS.Signals | null })
    }
    const replay = (snapshot: ProcessSnapshot) => {
      for (const stream of ["stdout", "stderr"] as const) {
        const total = stream === "stdout" ? snapshot.stdoutBytes : snapshot.stderrBytes
        const bytes = Buffer.from(snapshot[stream])
        const start = Math.max(0, consumed[stream] - (total - bytes.length))
        if (total > consumed[stream]) output?.(bytes.subarray(start).toString("utf8"), stream)
        consumed[stream] = Math.max(consumed[stream], total)
      }
      sequence = Math.max(sequence, snapshot.sequence)
      complete(snapshot.result)
    }
    const reconnect = () => {
      disconnect()
      if (!this.disposed && !settled && !retry)
        retry = setTimeout(() => {
          retry = undefined
          void attach()
        }, 250)
    }
    const attach = async () => {
      if (this.disposed || settled) return
      try {
        const client = await this.client()
        if (this.disposed || settled) return
        const onOutput = (event: ProcessOutputEvent) => {
          if (event.id !== id || event.sequence <= sequence) return
          sequence = event.sequence
          consumed[event.stream] = event.offset
          output?.(event.chunk, event.stream)
        }
        const onExit = (event: ProcessExitEvent) => {
          if (event.id === id) complete(event.result)
        }
        client.on("process-output", onOutput)
        client.on("process-exit", onExit)
        client.on("close", reconnect)
        disconnect = () => {
          client.off("process-output", onOutput)
          client.off("process-exit", onExit)
          client.off("close", reconnect)
        }
        await client.attachProcess(id, replay)
      } catch (error) {
        if (error instanceof DaemonError && error.code === "unknown-process") {
          complete({
            code: null,
            signal: null,
            stdout: "",
            stderr: "",
            error: "Agent process disappeared from the daemon",
          })
        } else {
          console.warn("[pi-lab] reconnecting background agent", id, error)
          reconnect()
        }
      }
    }
    const process: StartedNonInteractiveProcess = {
      processId: id,
      completion: new Promise((done) => {
        resolve = done
      }),
      acknowledge: async () => {
        await (await this.client()).forgetProcess(id).catch((error: unknown) => {
          if (!(error instanceof DaemonError && error.code === "unknown-process")) throw error
        })
        await rm(this.path(owner), { force: true })
        this.watches.delete(id)
        this.claimedOwners.delete(owner.ownerId)
      },
    }
    this.watches.set(id, process)
    this.cleanups.add(cleanup)
    void attach()
    return process
  }
}
