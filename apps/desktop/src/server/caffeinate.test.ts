import { execFileSync, spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import { caffeinateAdapter, createCaffeinateAdapter, type SpawnFn } from "./caffeinate"

const darwin = process.platform === "darwin"

describe.skipIf(!darwin)("caffeinate adapter", () => {
  it("passes the right arguments (injected fake spawn)", () => {
    const calls: string[][] = []
    const fake: SpawnFn = (command, args) => {
      calls.push([command, ...args])
      const child = new EventEmitter() as EventEmitter & { kill: () => void }
      child.kill = () => child.emit("exit")
      return child as never
    }
    const adapter = createCaffeinateAdapter(fake)
    const a = adapter.start("prevent-app-suspension")
    const b = adapter.start("prevent-display-sleep")
    expect(calls[0]).toEqual(["/usr/bin/caffeinate", "-i", "-w", String(process.pid)])
    expect(calls[1]).toEqual(["/usr/bin/caffeinate", "-d", "-i", "-w", String(process.pid)])
    expect(adapter.isStarted(a)).toBe(true)
    adapter.stop(a)
    expect(adapter.isStarted(a)).toBe(false)
    expect(adapter.isStarted(b)).toBe(true)
  })

  it("runs the real caffeinate process and stops it", async () => {
    const id = caffeinateAdapter.start("prevent-app-suspension")
    expect(caffeinateAdapter.isStarted(id)).toBe(true)
    await new Promise((r) => setTimeout(r, 300))
    const ps = execFileSync("/bin/ps", ["-axo", "args"], { encoding: "utf8" })
    expect(ps).toContain(`caffeinate -i -w ${process.pid}`)
    caffeinateAdapter.stop(id)
    await new Promise((r) => setTimeout(r, 300))
    const after = execFileSync("/bin/ps", ["-axo", "args"], { encoding: "utf8" })
    expect(after).not.toContain(`caffeinate -i -w ${process.pid}`)
    expect(caffeinateAdapter.isStarted(id)).toBe(false)
  })
})

describe.skipIf(darwin)("caffeinate adapter off macOS", () => {
  it("throws a clear error", () => {
    const adapter = createCaffeinateAdapter((c, a) => spawn(c, a))
    expect(() => adapter.start("prevent-app-suspension")).toThrow(/only supported on macOS/)
  })
})
