import { spawn } from "node-pty"
import { expect, test } from "vitest"
import addon from "../index.cjs"

/** The addon; null only on Windows, where every test here is skipped. */
const termios = addon as NonNullable<typeof addon>

/** Poll the local flags until they equal `want`, or fail after `timeoutMs`. */
async function waitForFlags(
  fd: number,
  want: { echo: boolean; icanon: boolean },
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const flags = termios.localFlags(fd)
    if ("error" in flags) throw new Error(flags.error)
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
  expect(termios.localFlags(-1)).toEqual({ error: expect.stringMatching(/Bad file descriptor/) })
})

test.skipIf(process.platform === "win32")(
  "setUtf8 turns on IUTF8 in a real PTY, and returns the error for a bad fd",
  async () => {
    const pty = spawn("/bin/sh", ["-c", "sleep 0.5; stty -a; sleep 1"], {
      cols: 120,
      rows: 24,
      encoding: null,
    })
    const fd = (pty as unknown as { fd: number }).fd
    expect(termios.setUtf8(fd)).toBeNull()
    const chunks: Buffer[] = []
    pty.onData((data) => chunks.push(data as unknown as Buffer))
    const deadline = Date.now() + 5000
    while (!Buffer.concat(chunks).toString("utf8").includes("iflags") && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 20))
    }
    expect(Buffer.concat(chunks).toString("utf8")).toMatch(/(^|\s)iutf8(\s|$)/m)
    expect(termios.setUtf8(-1)).toMatch(/Bad file descriptor/)
    pty.kill()
  },
)
