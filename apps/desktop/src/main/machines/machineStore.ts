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

/**
 * "Local server": this device's own PI Lab server. always: it keeps running
 * after the app quits (launchd); while-open: it stops when the app quits; off:
 * no local server, the app is a client of its added machines only.
 */
export const localServerModeSchema = z.enum(["always", "while-open", "off"])
export type LocalServerMode = z.infer<typeof localServerModeSchema>

/** What `machines.json` holds. */
export interface MachineFile {
  machines: StoredMachine[]
  behindPolicy: BehindPolicy
  localServer: LocalServerMode
  /** The machine New project is preset to: a stored machine id, or null for this Mac. */
  defaultMachine: string | null
  /** The multi-machine toggle (machine UI and Add machine); always on while a machine is added. */
  multiMachine: boolean
}

/** Files written before a setting existed read with its default. */
const machineFileSchema = z.object({
  machines: z.array(storedMachineSchema),
  behindPolicy: behindPolicySchema.default("auto"),
  localServer: localServerModeSchema.default("always"),
  defaultMachine: z.string().min(1).nullable().default(null),
  multiMachine: z.boolean().optional(),
})

/**
 * The stored machines and this device's machine settings; the defaults
 * (none, "auto", "always", this Mac, multi-machine off) when the file does not
 * exist. An older file holding only the machines array reads with the
 * defaults. Multi-machine reads on whenever a machine is added (also in a file
 * from before the toggle). Throws on a file others can read or a broken file.
 */
export function readMachineFile(profileDir: string): MachineFile {
  const path = join(profileDir, MACHINES_FILE)
  const parsed: unknown = existsSync(path) ? readOwnerOnlyJson(path) : { machines: [] }
  const file = machineFileSchema.parse(Array.isArray(parsed) ? { machines: parsed } : parsed)
  return { ...file, multiMachine: file.machines.length > 0 || file.multiMachine === true }
}

function readOwnerOnlyJson(path: string): unknown {
  assertOwnerOnly(path)
  return JSON.parse(readFileSync(path, "utf8"))
}

/** Replace `machines.json` (owner-only, temp file and rename). */
export function writeMachineFile(profileDir: string, file: MachineFile): void {
  writeOwnerOnly(join(profileDir, MACHINES_FILE), `${JSON.stringify(file, null, 2)}\n`)
}

let modeAtStart: LocalServerMode | null = null

/**
 * "Local server" as saved when this app started, read once: whether this
 * session has a local server and how it runs. A change in Settings applies to
 * the start at the next app start (the Quit behaviour reads the saved value).
 */
export function localServerAtStart(profileDir: string): LocalServerMode {
  modeAtStart ??= readMachineFile(profileDir).localServer
  return modeAtStart
}
