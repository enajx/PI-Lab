import { spawn } from "node-pty"
import { expect, test } from "vitest"
import termios from "../index.cjs"

/** Poll the local flags until they equal `want`, or fail after `timeoutMs`. */
async function waitForFlags(
  fd: number,
  want: { echo: boolean; icanon: boolean },
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const flags = termios.localFlags(fd)
    if (flags.echo === want.echo && flags.icanon === want.icanon) return
    if (Date.now() > deadline)
      throw new Error(`flags stayed ${JSON.stringify(flags)}, wanted ${JSON.stringify(want)}`)
    await new Promise((done) => setTimeout(done, 20))
  }
}

test.skipIf(process.platform === "win32")(
  "localFlags follows stty -echo, stty -icanon and back in a real PTY",
  async () => {
    const pty = spawn(
      "/bin/sh",
      ["-c", "stty -echo; sleep 1; stty -icanon; sleep 1; stty echo icanon; sleep 5"],
      { cols: 80, rows: 24 },
    )
    // node-pty's UnixTerminal keeps the master fd in `fd`; the public type does not list it.
    const fd = (pty as unknown as { fd: number }).fd
    expect(typeof fd).toBe("number")
    await waitForFlags(fd, { echo: false, icanon: true }, 3000)
    await waitForFlags(fd, { echo: false, icanon: false }, 3000)
    await waitForFlags(fd, { echo: true, icanon: true }, 3000)
    pty.kill()
  },
)

test.skipIf(process.platform === "win32")("localFlags rejects a bad argument", () => {
  expect(() => termios.localFlags("3" as unknown as number)).toThrow(TypeError)
  expect(() => termios.localFlags(-1)).toThrow(/Bad file descriptor/)
})
