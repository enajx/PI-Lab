import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { type AddressInfo, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { openLocalNetworkAccess, type RemoteAccess, runRemote, sshAddress } from "./remoteShell"

/** A stand-in ssh that fails like macOS does when the app has no Local Network access. */
test("an ssh 'No route to host' error points to the Local Network setting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lab-ssh-"))
  const ssh = join(dir, "ssh")
  writeFileSync(
    ssh,
    "#!/bin/sh\necho 'ssh: connect to host 10.0.0.9 port 22: No route to host' >&2\nexit 255\n",
  )
  chmodSync(ssh, 0o755)
  const access = { sshPath: ssh, extraSshArgs: [] } as unknown as RemoteAccess
  await expect(runRemote(access, "me@10.0.0.9", "true", null, 5_000)).rejects.toThrow(
    /No route to host.*Privacy & Security > Local Network/,
  )
})

/** A stand-in ssh answers `-G` like the real one; the app then connects to that address itself. */
test("the app opens its own connection to the machine's ssh address", async () => {
  const server = createServer()
  const connected = new Promise<void>((resolve) => {
    server.once("connection", (socket) => {
      socket.destroy()
      resolve()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  const dir = mkdtempSync(join(tmpdir(), "pi-lab-ssh-"))
  const ssh = join(dir, "ssh")
  writeFileSync(ssh, `#!/bin/sh\nprintf 'user me\\nhostname 127.0.0.1\\nport ${port}\\n'\n`)
  chmodSync(ssh, 0o755)
  const access = { sshPath: ssh, extraSshArgs: [] } as unknown as RemoteAccess
  await openLocalNetworkAccess(access, "my-alias", 5_000)
  await connected
  server.close()
})

/** Write a stand-in ssh script into a new temp folder; returns its path. */
function fakeSsh(script: string): string {
  const ssh = join(mkdtempSync(join(tmpdir(), "pi-lab-ssh-")), "ssh")
  writeFileSync(ssh, `#!/bin/sh\n${script}\n`)
  chmodSync(ssh, 0o755)
  return ssh
}

/** ssh ends while its input is still being sent: an error, not a crash of the app (EPIPE). */
test("ssh ending during a copy rejects instead of throwing EPIPE", async () => {
  const big = join(mkdtempSync(join(tmpdir(), "pi-lab-copy-")), "big.bin")
  writeFileSync(big, Buffer.alloc(8 * 1024 * 1024))
  const ssh = fakeSsh("echo 'connection closed' >&2\nexit 255")
  const access = { sshPath: ssh, extraSshArgs: [] } as unknown as RemoteAccess
  await expect(
    runRemote(access, "me@host", "cat > x", { file: big, onSent: () => undefined }, 5_000),
  ).rejects.toThrow(/connection closed/)
})

/** The time limit counts time without progress: a slow command that keeps answering finishes. */
test("a slow ssh command that keeps making progress is not killed by the time limit", async () => {
  const ssh = fakeSsh("for i in 1 2 3 4 5 6; do echo tick; sleep 0.3; done")
  const access = { sshPath: ssh, extraSshArgs: [] } as unknown as RemoteAccess
  await expect(runRemote(access, "me@host", "true", null, 1_000)).resolves.toContain("tick")
})

/** `ssh -G` that fails: its error text, not "no address". */
test("a failing ssh -G rejects with ssh's error text", async () => {
  const ssh = fakeSsh("echo 'Bad configuration option: foo' >&2\nexit 255")
  const access = { sshPath: ssh, extraSshArgs: [] } as unknown as RemoteAccess
  await expect(sshAddress(access, "box", 5_000)).rejects.toThrow(/Bad configuration option: foo/)
})

/** `ssh -G` that hangs is killed after the time limit. */
test("a hung ssh -G is stopped after the time limit", async () => {
  const ssh = fakeSsh("exec sleep 30")
  const access = { sshPath: ssh, extraSshArgs: [] } as unknown as RemoteAccess
  await expect(sshAddress(access, "box", 300)).rejects.toThrow(/did not answer/)
})

/** Add's Local Network touch does not wait on a hung `ssh -G`. */
test("the Local Network touch gives up on a hung ssh -G", async () => {
  const ssh = fakeSsh("exec sleep 30")
  const access = { sshPath: ssh, extraSshArgs: [] } as unknown as RemoteAccess
  await openLocalNetworkAccess(access, "box", 300)
})
