import { execFileSync, spawnSync } from "node:child_process"
import { describe, expect, test } from "vitest"
import { buildSshProbeArgs } from "./sshExec"

describe("SSH probe connection", () => {
  test("preserves the alias and passes manual overrides before the option terminator", () => {
    const args = buildSshProbeArgs({ host: "gpu", hostname: "10.0.0.5", user: "alice", port: 2222 })
    expect(args.slice(-9, -1)).toEqual([
      "-o",
      "Hostname=10.0.0.5",
      "-l",
      "alice",
      "-p",
      "2222",
      "--",
      "gpu",
    ])
    expect(() =>
      buildSshProbeArgs({ host: " -V ", hostname: null, user: null, port: null }),
    ).toThrow()
  })

  test.skipIf(spawnSync("ssh", ["-V"]).error !== undefined)(
    "OpenSSH reads overrides without connecting",
    () => {
      const output = execFileSync(
        "ssh",
        [
          "-G",
          "-F",
          "/dev/null",
          ...buildSshProbeArgs({
            host: "gpu",
            hostname: "10.0.0.5",
            user: "alice",
            port: 2222,
          }),
        ],
        { encoding: "utf8" },
      )
      expect(output).toContain("hostname 10.0.0.5\n")
      expect(output).toContain("user alice\n")
      expect(output).toContain("port 2222\n")
    },
  )
})
