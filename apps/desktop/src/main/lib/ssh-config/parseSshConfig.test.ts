import { describe, expect, test } from "vitest"
import { parseSshConfig } from "./parseSshConfig"

// Unit tests for the OpenSSH client-config parser (AGENTS.md §8 / §14): a pure
// string→data function, so a fixture string fully exercises it — no filesystem.

const FIXTURE = `
# A comment line, then a blank line follows.

Host gpu-box
  HostName 10.0.0.5
  User researcher
  Port 2222
  IdentityFile ~/.ssh/id_ed25519

Host laptop
    HostName laptop.local
    User ada

# Multiple aliases share the block below.
Host build ci runner
  HostName 192.168.1.10
  User runner

# Wildcards / patterns are not concrete machines and must be skipped.
Host *
  ServerAliveInterval 60

Host bastion-*
  User jump

Host alt-syntax
  HostName=alt.example.com
  Port=22

Host bare-alias
`

describe("parseSshConfig", () => {
  const hosts = parseSshConfig(FIXTURE)
  const byAlias = new Map(hosts.map((h) => [h.alias, h]))

  test("extracts HostName / User / Port for a full entry", () => {
    expect(byAlias.get("gpu-box")).toEqual({
      alias: "gpu-box",
      hostname: "10.0.0.5",
      user: "researcher",
      port: 2222,
    })
  })

  test("omits unset fields (no Port ⇒ undefined, not a default)", () => {
    expect(byAlias.get("laptop")).toEqual({
      alias: "laptop",
      hostname: "laptop.local",
      user: "ada",
    })
    expect(byAlias.get("laptop")?.port).toBeUndefined()
  })

  test("a Host line with multiple aliases yields one entry each, sharing the block", () => {
    for (const alias of ["build", "ci", "runner"]) {
      expect(byAlias.get(alias)).toMatchObject({
        alias,
        hostname: "192.168.1.10",
        user: "runner",
      })
    }
  })

  test("skips wildcard / pattern hosts entirely", () => {
    expect(byAlias.has("*")).toBe(false)
    expect(byAlias.has("bastion-*")).toBe(false)
    // The `Host *` block's directives don't leak onto concrete hosts either.
    expect(hosts.some((h) => "serverAliveInterval" in h)).toBe(false)
  })

  test("accepts the `key=value` separator syntax", () => {
    expect(byAlias.get("alt-syntax")).toEqual({
      alias: "alt-syntax",
      hostname: "alt.example.com",
      port: 22,
    })
  })

  test("keeps an alias with no keywords (HostName-less bare host)", () => {
    expect(byAlias.get("bare-alias")).toEqual({ alias: "bare-alias" })
  })

  test("never surfaces IdentityFile or other ignored directives", () => {
    const allowed = new Set(["alias", "hostname", "user", "port"])
    for (const host of hosts) {
      for (const key of Object.keys(host)) {
        expect(allowed.has(key), `unexpected field "${key}"`).toBe(true)
      }
      expect(host).not.toHaveProperty("identityFile")
    }
  })

  test("ignores comments and blank lines", () => {
    expect(parseSshConfig("# just a comment\n\n   \n")).toEqual([])
  })

  test("returns an empty list for empty input", () => {
    expect(parseSshConfig("")).toEqual([])
  })

  test("rejects a non-positive / non-numeric Port rather than storing NaN", () => {
    const parsed = parseSshConfig("Host x\n  Port notanumber\nHost y\n  Port 0\n")
    expect(parsed.find((h) => h.alias === "x")?.port).toBeUndefined()
    expect(parsed.find((h) => h.alias === "y")?.port).toBeUndefined()
  })
})
