const assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process")
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs")
const { tmpdir } = require("node:os")
const { join } = require("node:path")
const { test } = require("node:test")
const { selectPreviousBeta, verifyBetaSource } = require("./prepare-beta-source.cjs")

/** Real local Git fixture; no remote connection or user checkout is modified. */
test("accepts a clean pinned main commit and refuses unmerged or dirty source", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-beta-source-"))
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim()
  try {
    git(["init", "-b", "main"])
    git(["config", "core.hooksPath", "/dev/null"])
    git(["config", "core.fsmonitor", "false"])
    git(["config", "maintenance.auto", "false"])
    git(["config", "gc.auto", "0"])
    git(["config", "user.email", "test@pi-lab.local"])
    git(["config", "user.name", "Test"])
    git(["remote", "add", "origin", "git@github.com:enajx/PI-Lab.git"])
    writeFileSync(join(dir, "file"), "main")
    git(["add", "."])
    git(["commit", "-m", "main"])
    const sha = git(["rev-parse", "HEAD"])
    git(["update-ref", "refs/remotes/origin/main", sha])
    assert.equal(verifyBetaSource("0.1.0-beta.4", sha, "enajx/PI-Lab", dir), sha)
    writeFileSync(join(dir, "file"), "dirty")
    assert.throws(() => verifyBetaSource("0.1.0-beta.4", "main", "enajx/PI-Lab", dir), /clean/)
    git(["add", "."])
    git(["commit", "-m", "not merged"])
    assert.throws(() => verifyBetaSource("0.1.0-beta.4", "main", "enajx/PI-Lab", dir), /main/)
    git(["remote", "set-url", "origin", "https://github.com/enajx/PI-Lab.git"])
    assert.throws(() => verifyBetaSource("0.1.0-beta.4", "main", "enajx/PI-Lab", dir), /SSH/)
    assert.throws(
      () => verifyBetaSource("0.1.0-beta.4", "$(touch unsafe)", "enajx/PI-Lab", dir),
      /commit/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("chooses the highest published Beta with its matching ARM ZIP and requires a newer candidate", () => {
  const release = (n, overrides) => ({
    tag_name: `v0.1.0-beta.${n}`,
    draft: false,
    prerelease: true,
    assets: [{ name: `PI-Lab-0.1.0-beta.${n}-arm64.zip`, digest: `sha256:${"a".repeat(64)}` }],
    ...overrides,
  })
  const entries = [
    [release(3), release(99, { draft: true })],
    [release(2), { tag_name: "v0.1.0", draft: false, prerelease: false }],
  ]
  assert.deepEqual(selectPreviousBeta("0.1.0-beta.4", entries), {
    tag: "v0.1.0-beta.3",
    zip: "PI-Lab-0.1.0-beta.3-arm64.zip",
    digest: `sha256:${"a".repeat(64)}`,
  })
  assert.throws(() => selectPreviousBeta("0.1.0-beta.3", entries), /newer/)
  assert.throws(() => selectPreviousBeta("0.1.0-beta.4", [release(3, { assets: [] })]), /ZIP/)
  assert.deepEqual(selectPreviousBeta("0.1.0-beta.1", []), { tag: "-", zip: "", digest: "" })
})
