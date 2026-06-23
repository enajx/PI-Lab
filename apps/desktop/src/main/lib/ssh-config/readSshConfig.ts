import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseSshConfig, type SshConfigHost } from "./parseSshConfig"

/** The OS-default OpenSSH client config (`~/.ssh/config`). */
export function defaultSshConfigPath(): string {
  return join(homedir(), ".ssh", "config")
}

/**
 * Read and parse an OpenSSH client config. Thin I/O wrapper over the pure
 * {@link parseSshConfig}: an absent or unreadable file yields an empty list
 * (importing from a machine with no ssh config is a no-op, not an error).
 *
 * @param path config file to read; defaults to {@link defaultSshConfigPath}.
 */
export async function readSshConfig(path = defaultSshConfigPath()): Promise<SshConfigHost[]> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    return []
  }
  return parseSshConfig(raw)
}
