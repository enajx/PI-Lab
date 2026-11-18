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

/**
 * "When a machine is behind this app": auto installs this app's server bundle
 * over SSH, ask shows an Update button, never does nothing.
 */
export const behindPolicySchema = z.enum(["auto", "ask", "never"])
export type BehindPolicy = z.infer<typeof behindPolicySchema>

/** What `machines.json` holds. */
export interface MachineFile {
  machines: StoredMachine[]
  behindPolicy: BehindPolicy
}

const machineFileSchema = z.object({
  machines: z.array(storedMachineSchema),
  behindPolicy: behindPolicySchema,
})

/**
 * The stored machines and the behind policy; none and "auto" when the file
 * does not exist. An older file holding only the machines array reads with
 * "auto". Throws on a file others can read or a broken file.
 */
export function readMachineFile(profileDir: string): MachineFile {
  const path = join(profileDir, MACHINES_FILE)
  if (!existsSync(path)) return { machines: [], behindPolicy: "auto" }
  assertOwnerOnly(path)
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (Array.isArray(parsed)) {
    return { machines: z.array(storedMachineSchema).parse(parsed), behindPolicy: "auto" }
  }
  return machineFileSchema.parse(parsed)
}

/** Replace `machines.json` (owner-only, temp file and rename). */
export function writeMachineFile(profileDir: string, file: MachineFile): void {
  writeOwnerOnly(join(profileDir, MACHINES_FILE), `${JSON.stringify(file, null, 2)}\n`)
}
