import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { readSshConfigHosts } from "./sshConfig"

test("lists the Host names of an ssh config, without patterns, in file order", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lab-ssh-config-"))
  writeFileSync(
    join(dir, "config"),
    [
      "# my hosts",
      "Host lab-server lab-gpu",
      "  HostName 10.0.0.5",
      "  User me",
      "host   cluster",
      "Host=tripper2",
      'Host "quoted-box"',
      "Host *",
      "  ServerAliveInterval 30",
      "Host *.example.org !bad lab-? web",
      "Match host foo",
      "Host lab-server",
      "",
    ].join("\n"),
  )
  expect(readSshConfigHosts(join(dir, "config"))).toEqual([
    "lab-server",
    "lab-gpu",
    "cluster",
    "tripper2",
    "quoted-box",
    "web",
  ])
})

test("follows Include lines (relative to the config's folder, globs, absolute paths) without looping", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lab-ssh-config-"))
  const other = mkdtempSync(join(tmpdir(), "pi-lab-ssh-other-"))
  mkdirSync(join(dir, "config.d"))
  writeFileSync(join(dir, "config.d", "a.conf"), "Host from-a\n")
  writeFileSync(join(dir, "config.d", "b.conf"), "Host from-b\nInclude ../config\n")
  writeFileSync(join(other, "extra"), "Host from-other\n")
  writeFileSync(
    join(dir, "config"),
    `Include config.d/*\nInclude ${join(other, "extra")} missing-file\nHost main-host\n`,
  )
  expect(readSshConfigHosts(join(dir, "config"))).toEqual([
    "from-a",
    "from-b",
    "from-other",
    "main-host",
  ])
})

test("a missing ssh config gives no hosts", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lab-ssh-config-"))
  expect(readSshConfigHosts(join(dir, "config"))).toEqual([])
})
