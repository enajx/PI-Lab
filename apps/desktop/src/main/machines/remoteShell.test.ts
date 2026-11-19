import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { type AddressInfo, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { openLocalNetworkAccess, type RemoteAccess, runRemote } from "./remoteShell"

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
  await openLocalNetworkAccess(access, "my-alias")
  await connected
  server.close()
})
