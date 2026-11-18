import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { assertOwnerOnly, writeOwnerOnly } from "../../server/access"

/**
 * The remote machines this app connects to, with their device tokens, in the
 * app profile (`app.getPath("userData")`). A plain owner-only file, like SSH
 * keys (decided by the user; see md/branch-machines.md).
 */
export const MACHINES_FILE = "machines.json"

const storedMachineSchema = z.object({
  /** The remote server's machine id (its hello and `enroll` output). */
  machineId: z.string().min(1),
  name: z.string().min(1),
  /** ssh destination: a host name, `user@host`, or a Host alias from ~/.ssh/config. */
  sshHost: z.string().min(1),
  /** This app's device id on the remote server. */
  deviceId: z.string().min(1),
  /** This app's device token on the remote server. */
  token: z.string().min(1),
  /** Epoch ms. */
  addedAt: z.number(),
})

export type StoredMachine = z.infer<typeof storedMachineSchema>

/** The stored machines; none when the file does not exist. Throws on a file others can read or a broken file. */
export function readMachines(profileDir: string): StoredMachine[] {
  const path = join(profileDir, MACHINES_FILE)
  if (!existsSync(path)) return []
  assertOwnerOnly(path)
  return z.array(storedMachineSchema).parse(JSON.parse(readFileSync(path, "utf8")))
}

/** Replace the stored machines (owner-only, temp file and rename). */
export function writeMachines(profileDir: string, machines: StoredMachine[]): void {
  writeOwnerOnly(join(profileDir, MACHINES_FILE), `${JSON.stringify(machines, null, 2)}\n`)
}
