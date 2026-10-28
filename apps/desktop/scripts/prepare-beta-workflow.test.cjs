const assert = require("node:assert/strict")
const { readFileSync } = require("node:fs")
const { createRequire } = require("node:module")
const { join } = require("node:path")
const { test } = require("node:test")
const dependencyRequire = createRequire(require.resolve("electron-updater/out/providers/Provider"))
const { load } = dependencyRequire("js-yaml")

/** Verify the public-release trigger and security boundaries from the actual workflow. */
test("Prepare Beta is manual, SSH-only, signs before checks, and creates only a draft after success", () => {
  const text = readFileSync(join(__dirname, "../../../.github/workflows/prepare-beta.yml"), "utf8")
  const workflow = load(text)
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"])
  assert.equal(workflow.jobs.build["runs-on"], "macos-15")
  assert.equal(workflow.jobs.build.permissions.contents, "read")
  assert.equal(workflow.jobs.draft.permissions.contents, "write")
  assert.equal(workflow.jobs.draft.needs, "build")
  const steps = workflow.jobs.build.steps
  for (const checkout of steps.filter((step) => step.uses?.startsWith("actions/checkout@"))) {
    assert.match(checkout.with["ssh-key"], /RELEASE_REPO_SSH_KEY/)
    assert.equal(checkout.with["persist-credentials"], false)
  }
  const checks = steps.findIndex((step) => step.name === "Check Beta profile upgrade")
  const manifest = steps.findIndex((step) => step.name === "Record checked release assets")
  assert.ok(checks > 0 && manifest > checks)
  assert.ok(steps.some((step) => step.run?.includes("stapler validate")))
  assert.ok(steps.some((step) => step.run?.includes("spctl --assess")))
  assert.ok(
    steps.some(
      (step) => step.run?.includes("merge") || step.run?.includes("prepare-beta-source.cjs"),
    ),
  )
  assert.ok(!text.includes("PI_LAB_UPDATE_TEST_BUILD"))
  const publishing = workflow.jobs.draft.steps.find(
    (step) => step.name === "Create draft Beta release",
  )
  assert.match(publishing.run, /prepare-beta\.cjs.*publish/)
  assert.ok(!text.includes("release edit"))
})
