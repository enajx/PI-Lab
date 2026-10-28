// @ts-check
const { execFileSync } = require("node:child_process")
const { appendFileSync, readFileSync } = require("node:fs")
const { compareBetaVersions, validateBetaVersion } = require("./prepare-beta.cjs")

/**
 * Resolve only clean source already merged into main, fetched over SSH.
 * @param {string} version
 * @param {string} source
 * @param {string} repo
 * @param {string} directory
 * @returns {string}
 */
function verifyBetaSource(version, source, repo, directory) {
  validateBetaVersion(version)
  if (source !== "main" && !/^[a-f0-9]{40}$/.test(source))
    throw new Error("Choose main or a full lowercase 40-character main commit SHA")
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Invalid repository")
  const git = (args) =>
    execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  const origin = git(["remote", "get-url", "origin"])
  if (![`git@github.com:${repo}.git`, `ssh://git@github.com/${repo}.git`].includes(origin))
    throw new Error("Release source must come from this repository over SSH")
  const sha = git(["rev-parse", "HEAD"])
  if (source !== "main" && source !== sha)
    throw new Error("Checked-out commit does not match the requested commit")
  if (git(["status", "--porcelain"])) throw new Error("Release source must be clean")
  const ancestor = require("node:child_process").spawnSync(
    "git",
    ["merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"],
    { cwd: directory },
  )
  if (ancestor.error) throw ancestor.error
  if (ancestor.status !== 0) throw new Error("The selected commit is not in main's history")
  return sha
}

/**
 * @typedef {{tag_name:string,draft:boolean,prerelease:boolean,assets?:Array<{name:string,digest?:string|null}>}} BetaRelease
 */

/**
 * Pick a published Beta by version, excluding drafts and Stable releases.
 * @param {string} version
 * @param {Array<BetaRelease|BetaRelease[]>} releases
 * @returns {{tag:string,zip:string,digest:string}}
 */
function selectPreviousBeta(version, releases) {
  validateBetaVersion(version)
  if (!Array.isArray(releases)) throw new Error("Expected GitHub release metadata")
  const betas = releases
    .flat()
    .filter(
      (release) =>
        release &&
        release.draft === false &&
        release.prerelease === true &&
        typeof release.tag_name === "string" &&
        /^v\d+\.\d+\.\d+-beta\.\d+$/.test(release.tag_name),
    )
    .sort((left, right) => compareBetaVersions(right.tag_name.slice(1), left.tag_name.slice(1)))
  const previous = betas[0]
  if (!previous) return { tag: "-", zip: "", digest: "" }
  if (compareBetaVersions(version, previous.tag_name.slice(1)) <= 0)
    throw new Error("Choose a version newer than the previous published Beta")
  const name = `PI-Lab-${previous.tag_name.slice(1)}-arm64.zip`
  const zip = previous.assets?.find((asset) => asset.name === name)
  if (!zip) throw new Error("The previous Beta has no matching ARM64 ZIP")
  if (zip.digest != null && !/^sha256:[a-f0-9]{64}$/.test(zip.digest))
    throw new Error("The previous Beta ZIP has an invalid GitHub digest")
  return { tag: previous.tag_name, zip: name, digest: zip.digest ?? "" }
}

/** Emit only validated scalar values as GitHub step outputs.
 * @param {Record<string,string>} values
 */
function output(values) {
  const content = Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("")
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, content)
  process.stdout.write(content)
}

if (require.main === module) {
  const [command, ...args] = process.argv.slice(2)
  if (command === "verify" && args.length === 4)
    output({ sha: verifyBetaSource(args[0], args[1], args[2], args[3]) })
  else if (command === "previous" && args.length === 2)
    output(selectPreviousBeta(args[0], JSON.parse(readFileSync(args[1], "utf8"))))
  else
    throw new Error(
      "Use verify <version> <main-or-sha> <repo> <source-dir> or previous <version> <releases.json>",
    )
}

module.exports = { verifyBetaSource, selectPreviousBeta }
