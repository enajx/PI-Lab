import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { ProcessEvent, ProcessParams, ProcessSnapshot, ProcessSummary } from "./protocol"

const OUTPUT_LIMIT = { stdout: 1024 * 1024, stderr: 32 * 1024 }
const JOB_LIMIT = 256

/** A pipe-based process owned by the daemon, independent of client connections. */
export class ProcessJob {
  readonly id = randomUUID()
  private readonly child: ChildProcess
  private readonly listeners = new Set<(event: ProcessEvent) => void>()
  private readonly snapshot: ProcessSnapshot
  private timer: ReturnType<typeof setTimeout> | null = null
  private error: string | null = null
  readonly started: Promise<void>
  readonly closed: Promise<void>

  constructor(params: ProcessParams) {
    this.snapshot = {
      id: this.id,
      metadata: params.metadata,
      alive: true,
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      sequence: 0,
      result: null,
    }
    this.child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    })
    this.started = new Promise<void>((resolve, reject) => {
      this.child.once("spawn", resolve)
      this.child.once("error", reject)
    })
    this.child.on("error", (error) => {
      this.error = error.message
    })
    this.child.stdout?.setEncoding("utf8")
    this.child.stderr?.setEncoding("utf8")
    this.child.stdout?.on("data", (chunk: string) => this.output("stdout", chunk))
    this.child.stderr?.on("data", (chunk: string) => this.output("stderr", chunk))
    this.closed = new Promise<void>((resolve) => {
      this.child.once("close", (code, signal) => {
        if (this.timer) clearTimeout(this.timer)
        this.snapshot.alive = false
        this.snapshot.result = {
          code,
          signal,
          stdout: this.snapshot.stdout,
          stderr: this.snapshot.stderr,
          error: this.error,
        }
        this.emit({ kind: "process-exit", id: this.id, result: this.snapshot.result })
        resolve()
      })
    })
    if (params.timeoutMs !== undefined) {
      this.timer = setTimeout(() => {
        this.error = "Process timed out"
        this.kill()
      }, params.timeoutMs)
      this.timer.unref()
    }
  }

  /** Take a coherent replay boundary before subscribing to live output. */
  info(): ProcessSnapshot {
    return { ...this.snapshot, metadata: { ...this.snapshot.metadata } }
  }

  summary(): ProcessSummary {
    return { id: this.id, metadata: { ...this.snapshot.metadata }, alive: this.snapshot.alive }
  }

  subscribe(listener: (event: ProcessEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Stop the process group so subprocesses cannot keep running after quit. */
  kill(): void {
    if (!this.snapshot.alive || !this.child.pid) return
    if (process.platform === "win32") {
      this.child.kill("SIGKILL")
      return
    }
    try {
      process.kill(-this.child.pid, "SIGKILL")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }

  private output(stream: "stdout" | "stderr", chunk: string): void {
    const offsetKey = stream === "stdout" ? "stdoutBytes" : "stderrBytes"
    this.snapshot[offsetKey] += Buffer.byteLength(chunk)
    const output = Buffer.from(this.snapshot[stream] + chunk)
    let start = Math.max(0, output.length - OUTPUT_LIMIT[stream])
    while (start < output.length && ((output[start] ?? 0) & 0xc0) === 0x80) start += 1
    this.snapshot[stream] = output.subarray(start).toString("utf8")
    this.snapshot.sequence += 1
    this.emit({
      kind: "process-output",
      offset: this.snapshot[offsetKey],
      id: this.id,
      stream,
      chunk,
      sequence: this.snapshot.sequence,
    })
  }

  private emit(event: ProcessEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

/** Bound retained jobs without discarding unacknowledged completion results. */
export class ProcessJobStore {
  private readonly jobs = new Map<string, ProcessJob>()

  async start(params: ProcessParams): Promise<ProcessJob> {
    if (this.jobs.size >= JOB_LIMIT)
      throw new Error("Process job capacity reached; forget completed jobs")
    const job = new ProcessJob(params)
    this.jobs.set(job.id, job)
    await job.started.catch((error: unknown) => {
      this.jobs.delete(job.id)
      throw error
    })
    return job
  }

  get(id: string): ProcessJob {
    const job = this.jobs.get(id)
    if (!job) throw new UnknownProcessError(id)
    return job
  }

  list(): ProcessSummary[] {
    return [...this.jobs.values()].map((job) => job.summary())
  }

  forget(id: string): void {
    if (this.get(id).info().alive) throw new Error("Cannot forget a running process")
    this.jobs.delete(id)
  }

  async close(): Promise<void> {
    for (const job of this.jobs.values()) job.kill()
    await Promise.all([...this.jobs.values()].map((job) => job.closed))
    this.jobs.clear()
  }
}

/** Distinguish confirmed missing jobs from retryable transport failures. */
export class UnknownProcessError extends Error {
  constructor(id: string) {
    super(`Unknown process job ${id}`)
  }
}
