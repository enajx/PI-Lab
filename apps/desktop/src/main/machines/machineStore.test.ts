import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import {
  MACHINES_FILE,
  type MachineFile,
  readMachineFile,
  type StoredMachine,
  writeMachineFile,
} from "./machineStore"

let profileDir: string

beforeEach(() => {
  profileDir = mkdtempSync(join(tmpdir(), "pi-lab-machines-test-"))
})

afterEach(() => {
  rmSync(profileDir, { recursive: true, force: true })
})

const machine: StoredMachine = {
  machineId: "4f0c5a8e-1111-4222-8333-444455556666",
  name: "Lab server",
  sshHost: "lab",
  deviceId: "9d3b2c1a-aaaa-4bbb-8ccc-ddddeeeeffff",
  token: "t".repeat(43),
  addedAt: 1_700_000_000_000,
}

const defaults = {
  behindPolicy: "auto",
  localServer: "always",
  defaultMachine: null,
  multiMachine: false,
} as const

test("no machines.json means no machines, machines behind this app are updated automatically, the local server always runs, this Mac is the default machine and multi-machine is off", () => {
  expect(readMachineFile(profileDir)).toEqual({ machines: [], ...defaults })
})

test("a machines.json from before the behind policy reads with the defaults, multi-machine on as a machine is added", () => {
  writeFileSync(join(profileDir, MACHINES_FILE), JSON.stringify([machine]), { mode: 0o600 })
  expect(readMachineFile(profileDir)).toEqual({
    machines: [machine],
    ...defaults,
    multiMachine: true,
  })
})

test("a machines.json from before the multi-machine toggle reads it on only when a machine is added", () => {
  const path = join(profileDir, MACHINES_FILE)
  const old = { behindPolicy: "auto", localServer: "always", defaultMachine: null }
  writeFileSync(path, JSON.stringify({ ...old, machines: [] }), { mode: 0o600 })
  expect(readMachineFile(profileDir).multiMachine).toBe(false)
  writeFileSync(path, JSON.stringify({ ...old, machines: [machine] }), { mode: 0o600 })
  expect(readMachineFile(profileDir).multiMachine).toBe(true)
  // Off with a machine added is read as on (locked on while any machine is added).
  writeFileSync(path, JSON.stringify({ ...old, machines: [machine], multiMachine: false }))
  expect(readMachineFile(profileDir).multiMachine).toBe(true)
})

test("a machines.json from before the local server setting reads with Always and this Mac", () => {
  writeFileSync(
    join(profileDir, MACHINES_FILE),
    JSON.stringify({ machines: [machine], behindPolicy: "ask" }),
    { mode: 0o600 },
  )
  expect(readMachineFile(profileDir)).toEqual({
    ...defaults,
    machines: [machine],
    behindPolicy: "ask",
    multiMachine: true,
  })
})

test("machines are written owner-only and atomically, and read back the same", () => {
  const written: MachineFile = {
    machines: [machine],
    behindPolicy: "ask",
    localServer: "off",
    defaultMachine: machine.machineId,
    multiMachine: true,
  }
  writeMachineFile(profileDir, written)
  const path = join(profileDir, MACHINES_FILE)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  // No temp file is left next to it.
  expect(readdirSync(profileDir)).toEqual([MACHINES_FILE])
  expect(readMachineFile(profileDir)).toEqual(written)
  const next: MachineFile = {
    ...defaults,
    machines: [],
    behindPolicy: "never",
    localServer: "while-open",
    multiMachine: true,
  }
  writeMachineFile(profileDir, next)
  expect(readMachineFile(profileDir)).toEqual(next)
})

test("a machines.json other users can read, or a broken one, is refused", () => {
  const path = join(profileDir, MACHINES_FILE)
  writeFileSync(path, JSON.stringify([machine]), { mode: 0o644 })
  chmodSync(path, 0o644)
  expect(() => readMachineFile(profileDir)).toThrow("readable by other users")
  chmodSync(path, 0o600)
  writeFileSync(path, JSON.stringify([{ ...machine, token: 5 }]))
  expect(() => readMachineFile(profileDir)).toThrow()
})
