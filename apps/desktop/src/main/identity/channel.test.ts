import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { channelDataDir, channelFromAppName, channelIdentity, resolveAppChannel } from "./channel"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("PI Lab channels", () => {
  test("unpackaged development uses Alpha", () => {
    expect(resolveAppChannel(false, "/unused")).toBe("alpha")
    expect(channelIdentity("alpha")).toEqual({
      name: "PI Lab Alpha",
      dataDirName: ".pi-lab-alpha",
      autostartName: "com.pi-lab.desktop.alpha",
    })
  })

  test.each(["alpha", "beta", "stable"] as const)("reads %s from packaged metadata", (channel) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-lab-channel-"))
    dirs.push(dir)
    writeFileSync(join(dir, "package.json"), JSON.stringify({ piLabChannel: channel }))
    expect(resolveAppChannel(true, dir)).toBe(channel)
  })

  test("legacy packaged builds and names stay Stable", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-lab-channel-"))
    dirs.push(dir)
    writeFileSync(join(dir, "package.json"), "{}")
    expect(resolveAppChannel(true, dir)).toBe("stable")
    expect(channelIdentity("stable")).toEqual({
      name: "PI Lab",
      dataDirName: ".pi-lab",
      autostartName: "com.pi-lab.desktop",
    })
    expect(channelFromAppName("PI Lab")).toBe("stable")
    expect(channelFromAppName("PI Lab Beta")).toBe("beta")
  })

  test("separates state while preserving an explicit test override", () => {
    expect(channelDataDir("alpha", undefined)).toMatch(/\.pi-lab-alpha$/)
    expect(channelDataDir("beta", undefined)).toMatch(/\.pi-lab-beta$/)
    expect(channelDataDir("stable", undefined)).toBeUndefined()
    expect(channelDataDir("alpha", "/tmp/pi-lab-test")).toBe("/tmp/pi-lab-test")
  })

  test("invalid channel metadata fails before opening another channel's data", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-lab-channel-"))
    dirs.push(dir)
    writeFileSync(join(dir, "package.json"), '{"piLabChannel":"preview"}')
    expect(() => resolveAppChannel(true, dir)).toThrow("Invalid PI Lab channel")
  })
})
