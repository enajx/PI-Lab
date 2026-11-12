import { type ChildProcess, execFile, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { basename, dirname, join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export type EngineState = "stopped" | "loading" | "ready" | "failed"

export interface EngineStatus {
  state: EngineState
  error: string | null
}

/** The transcription engine the dictation service drives. */
export interface DictationEngine {
  status: () => EngineStatus
  /** Start (or restart with another model) and resolve once the model is loaded. */
  prepare: (modelPath: string) => Promise<void>
  /** Transcribe a 16 kHz mono 16-bit WAV; `language` is "en" or "auto". */
  transcribe: (wav: Buffer, language: string) => Promise<string>
  stop: () => void
}

/** The engine answered with an HTTP error; whisper-server sends 400 for a WAV with no samples. */
export class EngineHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`The dictation engine failed (HTTP ${status}): ${body.slice(0, 300)}`)
    this.name = "EngineHttpError"
  }
}

const LOAD_TIMEOUT_MS = 120_000
const TRANSCRIBE_TIMEOUT_MS = 300_000
const STDERR_TAIL_BYTES = 4000

/**
 * Path of the bundled whisper-server for this machine, or null when it is not built.
 * Synchronous (one stat), so app start does not wait on it before the window opens.
 */
export function resolveWhisperServer(resourcesDir: string): string | null {
  if (process.platform !== "darwin") return null
  const path = join(resourcesDir, `darwin-${process.arch}`, "whisper-server")
  if (!existsSync(path)) return null
  return (statSync(path).mode & 0o111) !== 0 ? path : null
}

/** Ask the OS for a free loopback port. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("Could not find a free port for the dictation engine"))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

interface Running {
  /** Null until the process is spawned (the free port is found first). */
  child: ChildProcess | null
  modelPath: string
  port: number
  ready: Promise<void>
  stderr: string
}

/**
 * Runs whisper.cpp's `whisper-server` on 127.0.0.1 and keeps it warm. A model
 * change stops the old process and starts a new one. Process exits and load
 * failures are reported through {@link status}. The running server's PID is kept
 * in `pidFile` so a later app start can stop a server left by a crash.
 */
export class WhisperServerEngine implements DictationEngine {
  private running: Running | null = null
  private current: EngineStatus = { state: "stopped", error: null }

  constructor(
    private readonly binaryPath: string,
    private readonly pidFile: string,
  ) {}

  status(): EngineStatus {
    return this.current
  }

  /** Single flight: the start is stored before any await, so concurrent calls share it. */
  prepare(modelPath: string): Promise<void> {
    if (this.running?.modelPath === modelPath) return this.running.ready
    this.stop()
    const running: Running = {
      child: null,
      modelPath,
      port: 0,
      ready: Promise.resolve(),
      stderr: "",
    }
    this.running = running
    this.current = { state: "loading", error: null }
    running.ready = this.start(running).catch((error: Error) => {
      if (this.running === running) {
        this.running = null
        running.child?.kill()
        this.current = { state: "failed", error: error.message }
      }
      throw error
    })
    return running.ready
  }

  private async start(running: Running): Promise<void> {
    const port = await freePort()
    if (this.running !== running)
      throw new Error("The dictation engine was stopped or restarted with another model")
    const child = spawn(
      this.binaryPath,
      [
        "--model",
        running.modelPath,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--no-timestamps",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    )
    running.child = child
    running.port = port
    const pid = child.pid
    if (pid !== undefined) {
      mkdirSync(dirname(this.pidFile), { recursive: true })
      writeFileSync(this.pidFile, String(pid))
    }
    child.stderr?.on("data", (chunk: Buffer) => {
      running.stderr = (running.stderr + chunk.toString()).slice(-STDERR_TAIL_BYTES)
    })
    const exited = new Promise<never>((_, reject) => {
      child.once("error", (error) => reject(error))
      child.once("exit", (code, signal) => {
        if (pid !== undefined) this.forgetPid(pid)
        reject(
          new Error(
            `The dictation engine stopped (${signal ?? `exit code ${code}`}). ${lastLines(running.stderr)}`.trim(),
          ),
        )
      })
    })
    // Keep later exits from becoming unhandled rejections; they are read from status.
    exited.catch((error: Error) => {
      if (this.running !== running) return
      this.running = null
      this.current = { state: "failed", error: error.message }
    })
    await Promise.race([waitForHealth(port), exited])
    if (this.running === running) this.current = { state: "ready", error: null }
  }

  async transcribe(wav: Buffer, language: string): Promise<string> {
    const running = this.running
    if (!running) throw new Error("The dictation engine is not running")
    await running.ready
    const form = new FormData()
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav")
    form.append("response_format", "json")
    form.append("temperature", "0.0")
    form.append("language", language)
    form.append("no_timestamps", "true")
    const response = await fetch(`http://127.0.0.1:${running.port}/inference`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    })
    const body = await response.text()
    if (!response.ok) throw new EngineHttpError(response.status, body)
    const parsed = JSON.parse(body) as { text?: unknown; error?: unknown }
    if (typeof parsed.error === "string")
      throw new Error(`The dictation engine failed: ${parsed.error}`)
    if (typeof parsed.text !== "string")
      throw new Error("The dictation engine returned no text field")
    return parsed.text
  }

  stop(): void {
    const running = this.running
    this.running = null
    this.current = { state: "stopped", error: null }
    const child = running?.child
    if (!child) return
    if (child.pid !== undefined) this.forgetPid(child.pid)
    if (child.exitCode === null) child.kill()
  }

  /** Remove the PID record when it still names this process. */
  private forgetPid(pid: number): void {
    if (existsSync(this.pidFile) && readFileSync(this.pidFile, "utf8").trim() === String(pid))
      rmSync(this.pidFile, { force: true })
  }
}

/**
 * Stop a whisper-server left running by an app that crashed or was killed: when the PID
 * in `pidFile` belongs to a live process whose command is named whisper-server, kill it.
 * The record is removed in every case. Call before the engine starts a server.
 */
export async function killLeftoverWhisperServer(pidFile: string): Promise<void> {
  if (!existsSync(pidFile)) return
  const pid = Number(readFileSync(pidFile, "utf8").trim())
  rmSync(pidFile, { force: true })
  if (!Number.isInteger(pid) || pid <= 0) return
  // `ps` exits non-zero when no process has this PID.
  const command = await execFileAsync("ps", ["-p", String(pid), "-o", "comm="]).then(
    ({ stdout }) => stdout.trim(),
    () => "",
  )
  if (basename(command) === "whisper-server") killIfAlive(pid)
}

/** Kill a process; a process that already exited (ESRCH) is fine, any other error surfaces. */
function killIfAlive(pid: number): void {
  try {
    process.kill(pid)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

function lastLines(text: string): string {
  return text.trim().split("\n").slice(-3).join(" ")
}

/** Poll the server's /health route until the model is loaded. */
async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + LOAD_TIMEOUT_MS
  while (Date.now() < deadline) {
    const ok = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    }).then(
      (response) => response.ok,
      () => false,
    )
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("The dictation engine did not finish loading the model in time")
}
