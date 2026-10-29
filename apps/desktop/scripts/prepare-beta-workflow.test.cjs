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
  assert.deepEqual(workflow.jobs.build.needs, ["resolve", "ci"])
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

/** Verify the Beta release runs full CI on the same commit it builds, before any signing. */
test("Prepare Beta runs the full CI on the selected SHA before building, without secrets", () => {
  const workflows = join(__dirname, "../../../.github/workflows")
  const beta = load(readFileSync(join(workflows, "prepare-beta.yml"), "utf8"))
  const ci = load(readFileSync(join(workflows, "ci.yml"), "utf8"))
  /** Return the text of a GitHub Actions expression such as expr("inputs.ref"). */
  const expr = (body) => `$\{{ ${body} }}`
  const sha = expr("needs.resolve.outputs.sha")

  assert.equal(beta.jobs.resolve.outputs.sha, expr("steps.commit.outputs.sha"))
  const required = [
    "RELEASE_REPO_SSH_KEY",
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ]
  const [secretCheck, ...resolveSteps] = beta.jobs.resolve.steps
  assert.equal(secretCheck.name, "Check release secrets")
  assert.equal(secretCheck.uses, undefined)
  assert.deepEqual(
    secretCheck.env,
    Object.fromEntries(required.map((name) => [name, expr(`secrets.${name}`)])),
  )
  for (const name of required) assert.ok(secretCheck.run.includes(`'${name}'`))
  assert.match(secretCheck.run, /missing\.join/)
  assert.ok(!JSON.stringify(resolveSteps).includes("secrets."))
  assert.ok(!JSON.stringify(beta.jobs.resolve).includes("actions/checkout"))
  assert.equal(beta.jobs.ci.uses, "./.github/workflows/ci.yml")
  assert.equal(beta.jobs.ci.needs, "resolve")
  assert.deepEqual(beta.jobs.ci.with, { ref: sha })
  assert.equal(beta.jobs.ci.secrets, undefined)
  assert.deepEqual(beta.jobs.ci.permissions, { contents: "read" })
  assert.ok(!JSON.stringify(beta.jobs.ci).includes("secrets"))
  const buildSteps = beta.jobs.build.steps
  assert.ok(!buildSteps.some((step) => step.name === "Check source and tests"))
  for (const command of ["bun run typecheck", "bun run lint", "bun run test"])
    assert.ok(!buildSteps.some((step) => step.run?.includes(command)))
  assert.ok(beta.jobs.build.needs.includes("ci"))
  assert.equal(beta.jobs.build.env.SOURCE_COMMIT, sha)
  const source = beta.jobs.build.steps.find((step) => step.name === "Check out selected app source")
  assert.equal(source.with.ref, sha)

  assert.ok("workflow_dispatch" in ci.on)
  assert.deepEqual(ci.on.workflow_call.inputs.ref, {
    description: "Full commit SHA to check out and test",
    required: true,
    type: "string",
  })
  assert.deepEqual(Object.keys(ci.jobs).sort(), ["e2e", "lint", "test", "typecheck"])
  for (const job of Object.values(ci.jobs)) {
    const checkouts = job.steps.filter((step) => step.uses?.startsWith("actions/checkout@"))
    assert.equal(checkouts.length, 1)
    assert.equal(checkouts[0].with.ref, expr("inputs.ref || github.sha"))
  }
  assert.match(ci.concurrency.group, /inputs\.ref && .*github\.run_id/)
  assert.equal(ci.concurrency["cancel-in-progress"], expr("!inputs.ref"))
})
