import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { MachineConnections } from "./machineConnections"
import { readMachineFile, type StoredMachine, writeMachineFile } from "./machineStore"

/**
 * This device's machine settings (Local server, default machine) through
 * MachineConnections, with stored machines that are never connected (no
 * start(), so no ssh runs).
 */

let profileDir: string

beforeEach(() => {
  profileDir = mkdtempSync(join(tmpdir(), "pi-lab-machine-settings-test-"))
})

afterEach(() => {
  rmSync(profileDir, { recursive: true, force: true })
})

function stored(machineId: string, name: string): StoredMachine {
  return {
    machineId,
    name,
    sshHost: name.toLowerCase(),
    deviceId: `device-${machineId}`,
    token: "t".repeat(43),
    addedAt: 1_700_000_000_000,
  }
}

const lab = stored("4f0c5a8e-1111-4222-8333-444455556666", "Lab")
const gpu = stored("7a1b2c3d-1111-4222-8333-444455556666", "Gpu")

function connections(): MachineConnections {
  return new MachineConnections({
    profileDir,
    access: {
      sshPath: "/usr/bin/false",
      extraSshArgs: [],
      dataDir: ".pi-lab",
      serverPrefix: ".pi-lab/server",
      appPath: "/Applications/PI Lab.app",
      enrollCommand: "false",
      installArgs: [],
      installEnv: {},
    },
    deviceName: "PI Lab on test",
    localMachineId: async () => "local-machine",
    bundle: () => null,
    log: () => undefined,
  })
}

function withMachines(machines: StoredMachine[]): void {
  writeMachineFile(profileDir, {
    machines,
    behindPolicy: "auto",
    localServer: "always",
    defaultMachine: null,
    multiMachine: machines.length > 0,
  })
}

test("the Local server setting and the default machine are saved and read back after a restart", () => {
  withMachines([lab, gpu])
  const first = connections()
  expect(first.deviceSettings()).toEqual({
    localServer: "always",
    defaultMachine: null,
    multiMachine: true,
  })
  first.setDefaultMachine(gpu.machineId)
  first.setLocalServer("while-open")
  expect(connections().deviceSettings()).toEqual({
    localServer: "while-open",
    defaultMachine: gpu.machineId,
    multiMachine: true,
  })
  expect(readMachineFile(profileDir).machines).toEqual([lab, gpu])
})

test("with the local server off the default cannot be this Mac", () => {
  withMachines([lab])
  const machines = connections()
  expect(() => machines.setLocalServer("off")).toThrow("Choose another default machine")
  expect(machines.deviceSettings().localServer).toBe("always")
  machines.setDefaultMachine(lab.machineId)
  machines.setLocalServer("off")
  expect(() => machines.setDefaultMachine(null)).toThrow("local server is off")
  expect(machines.deviceSettings()).toEqual({
    localServer: "off",
    defaultMachine: lab.machineId,
    multiMachine: true,
  })
})

test("an unknown machine cannot be the default", () => {
  withMachines([lab])
  expect(() => connections().setDefaultMachine("no-such-machine")).toThrow("not added")
})

test("removing the default machine makes this Mac the default, or another machine while the local server is off", async () => {
  withMachines([lab, gpu])
  const machines = connections()
  machines.setDefaultMachine(lab.machineId)
  await machines.remove(lab.machineId)
  expect(machines.deviceSettings().defaultMachine).toBeNull()

  withMachines([lab, gpu])
  const off = connections()
  off.setDefaultMachine(lab.machineId)
  off.setLocalServer("off")
  await off.remove(lab.machineId)
  expect(off.deviceSettings().defaultMachine).toBe(gpu.machineId)
  expect(readMachineFile(profileDir).defaultMachine).toBe(gpu.machineId)

  // The last machine cannot be removed while the local server is off.
  await expect(off.remove(gpu.machineId)).rejects.toThrow("Turn the local server on")
  expect(off.list().map((machine) => machine.machineId)).toEqual([gpu.machineId])
  expect(readMachineFile(profileDir).defaultMachine).toBe(gpu.machineId)
})

test("multi-machine is off for a new device, can be turned on and off, and cannot be turned off while a machine is added", async () => {
  const fresh = connections()
  expect(fresh.deviceSettings().multiMachine).toBe(false)
  fresh.setMultiMachine(true)
  expect(connections().deviceSettings().multiMachine).toBe(true)
  fresh.setMultiMachine(false)
  expect(readMachineFile(profileDir).multiMachine).toBe(false)

  withMachines([lab])
  const added = connections()
  expect(() => added.setMultiMachine(false)).toThrow("Remove all machines")
  expect(added.deviceSettings().multiMachine).toBe(true)
  await added.remove(lab.machineId)
  added.setMultiMachine(false)
  expect(connections().deviceSettings().multiMachine).toBe(false)
})
