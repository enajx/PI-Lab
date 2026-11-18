import { spawn } from "node-pty"
import { expect, test } from "vitest"
import termios from "../index.cjs"

/** Poll the ECHO bit until it equals `want`, or fail after `timeoutMs`. */
async function waitForEcho(fd: number, want: boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (termios.echoEnabled(fd) !== want) {
    if (Date.now() > deadline) throw new Error(`ECHO bit did not become ${want}`)
    await new Promise((done) => setTimeout(done, 20))
  }
}

test.skipIf(process.platform === "win32")(
  "echoEnabled follows stty -echo / stty echo in a real PTY",
  async () => {
    const pty = spawn("/bin/sh", ["-c", "stty -echo; sleep 1; stty echo; sleep 5"], {
      cols: 80,
      rows: 24,
    })
    // node-pty's UnixTerminal keeps the master fd in `fd`; the public type does not list it.
    const fd = (pty as unknown as { fd: number }).fd
    expect(typeof fd).toBe("number")
    await waitForEcho(fd, false, 3000)
    await waitForEcho(fd, true, 3000)
    pty.kill()
  },
)

test.skipIf(process.platform === "win32")("echoEnabled rejects a bad argument", () => {
  expect(() => termios.echoEnabled("3" as unknown as number)).toThrow(TypeError)
  expect(() => termios.echoEnabled(-1)).toThrow(/Bad file descriptor/)
})
