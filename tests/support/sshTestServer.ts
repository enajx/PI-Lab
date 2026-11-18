import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * A throwaway user-level sshd on 127.0.0.1 for tests that need real ssh
 * (tunnel tests, the flood test). It accepts only a generated client key and
 * runs as the current user, so `ssh` reaches this machine as itself.
 */
export interface SshTestServer {
  port: number
  /** Temp folder holding keys, config and known_hosts. */
  dir: string
  /** ssh options that point a client at this server; pass before the host. */
  clientArgs: string[]
  /** Host name to pass to ssh. */
  host: string
  stop: () => Promise<void>
}

export const SSHD_PATH = "/usr/sbin/sshd"

/** A free TCP port on 127.0.0.1. */
export async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("no port from listen(0)")
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

/** Start sshd and resolve once it listens; reject with its log if it exits first. */
export async function startSshTestServer(): Promise<SshTestServer> {
  const dir = mkdtempSync(join(tmpdir(), "sshd-test-"))
  const keygen = (name: string): void => {
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, name)])
  }
  keygen("host_key")
  keygen("client_key")
  execFileSync("cp", [join(dir, "client_key.pub"), join(dir, "authorized_keys")])
  writeFileSync(
    join(dir, "sshd_config"),
    [
      `HostKey ${join(dir, "host_key")}`,
      `AuthorizedKeysFile ${join(dir, "authorized_keys")}`,
      "UsePAM no",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "StrictModes no",
      `PidFile ${join(dir, "sshd.pid")}`,
      "ListenAddress 127.0.0.1",
      "",
    ].join("\n"),
  )
  // An empty client config, so the developer's ~/.ssh/config does not change the test.
  writeFileSync(join(dir, "ssh_config"), "")
  const port = await freePort()
  const sshd = spawn(SSHD_PATH, ["-D", "-e", "-f", join(dir, "sshd_config"), "-p", String(port)], {
    stdio: ["ignore", "ignore", "pipe"],
  })
  await waitForListening(sshd)
  const clientArgs = [
    "-F",
    join(dir, "ssh_config"),
    "-p",
    String(port),
    "-i",
    join(dir, "client_key"),
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    `UserKnownHostsFile=${join(dir, "known_hosts")}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
  ]
  const stop = async (): Promise<void> => {
    if (sshd.exitCode === null && sshd.signalCode === null) {
      const exited = new Promise<void>((resolve) => sshd.once("exit", () => resolve()))
      sshd.kill("SIGTERM")
      await exited
    }
    rmSync(dir, { recursive: true, force: true })
  }
  return { port, dir, clientArgs, host: "127.0.0.1", stop }
}

/** Resolve when sshd logs "Server listening"; reject with its log if it exits. */
function waitForListening(sshd: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let log = ""
    const onExit = (code: number | null): void => {
      reject(new Error(`sshd exited (code ${code}) before listening:\n${log}`))
    }
    sshd.once("exit", onExit)
    sshd.stderr?.on("data", (chunk: Buffer) => {
      log += chunk.toString()
      if (log.includes("Server listening")) {
        sshd.off("exit", onExit)
        resolve()
      }
    })
  })
}
