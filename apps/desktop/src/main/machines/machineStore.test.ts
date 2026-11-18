import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { MACHINES_FILE, readMachines, type StoredMachine, writeMachines } from "./machineStore"

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

test("no machines.json means no machines", () => {
  expect(readMachines(profileDir)).toEqual([])
})

test("machines are written owner-only and atomically, and read back the same", () => {
  writeMachines(profileDir, [machine])
  const path = join(profileDir, MACHINES_FILE)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  // No temp file is left next to it.
  expect(readdirSync(profileDir)).toEqual([MACHINES_FILE])
  expect(readMachines(profileDir)).toEqual([machine])
  writeMachines(profileDir, [])
  expect(readMachines(profileDir)).toEqual([])
})

test("a machines.json other users can read, or a broken one, is refused", () => {
  const path = join(profileDir, MACHINES_FILE)
  writeFileSync(path, JSON.stringify([machine]), { mode: 0o644 })
  chmodSync(path, 0o644)
  expect(() => readMachines(profileDir)).toThrow("readable by other users")
  chmodSync(path, 0o600)
  writeFileSync(path, JSON.stringify([{ ...machine, token: 5 }]))
  expect(() => readMachines(profileDir)).toThrow()
})
