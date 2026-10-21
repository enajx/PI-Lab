import type { ChildProcess } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "vite"
import { expect, test } from "vitest"
import { TerminalSupervisor } from "./supervisor"

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("process lifecycle did not settle")
    await new Promise((done) => setTimeout(done, 10))
  }
}

test("a production daemon survives disposal, is adopted, and reaps its PTY on shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-lab-daemon-lifecycle-"))
  const bundle = join(directory, "bundle")
  const socketPath = join(directory, "daemon.sock")
  const nativePty = createRequire(import.meta.url).resolve("node-pty")
  // Compile the production entry using the same ESM/Node target as the desktop build.
  await build({
    configFile: false,
    logLevel: "silent",
    build: {
      outDir: bundle,
      ssr: resolve(__dirname, "daemonEntry.ts"),
      target: "node20",
      rollupOptions: {
        external: ["node-pty"],
        output: { format: "es", entryFileNames: "index.js", paths: { "node-pty": nativePty } },
      },
    },
  })
  await writeFile(join(bundle, "package.json"), JSON.stringify({ type: "module" }))
  const first = new TerminalSupervisor({ socketPath, daemonEntry: join(bundle, "index.js") })
  const second = new TerminalSupervisor({ socketPath, daemonEntry: join(bundle, "index.js") })
  let daemonPid: number | undefined
  let terminalPid: number | null = null
  try {
    const client = await first.ensureClient()
    daemonPid = (first as unknown as { child: ChildProcess }).child.pid
    const session = await client.spawn({ command: "/bin/cat", args: [] })
    terminalPid = session.pid
    first.dispose()
    const adopted = await second.ensureClient()
    expect(await adopted.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: session.id, pid: terminalPid, alive: true }),
      ]),
    )
    await adopted.write(session.id, "AFTER-ADOPTION\n")
    let output = ""
    adopted.on("data", (event) => {
      if (event.sessionId === session.id) output += event.chunk
    })
    await adopted.attach(session.id, ({ scrollback }) => {
      output += scrollback
    })
    await waitFor(() => output.includes("AFTER-ADOPTION"))
    second.dispose()
    expect(daemonPid).toBeTypeOf("number")
    if (daemonPid === undefined || terminalPid === null) throw new Error("missing child pid")
    process.kill(daemonPid, "SIGTERM")
    await waitFor(() => !processAlive(daemonPid as number) && !processAlive(terminalPid as number))
  } finally {
    first.dispose()
    second.dispose()
    if (daemonPid !== undefined && processAlive(daemonPid)) process.kill(daemonPid, "SIGTERM")
    if (terminalPid !== null && processAlive(terminalPid)) process.kill(terminalPid, "SIGKILL")
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
