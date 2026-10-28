const assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process")
const { createHash } = require("node:crypto")
const {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require("node:fs")
const { tmpdir } = require("node:os")
const { delimiter, join } = require("node:path")
const { test } = require("node:test")
const { createBetaManifest, publishBetaDraft, validateBetaManifest } = require("./prepare-beta.cjs")

const VERSION = "0.1.0-beta.4"
const COMMIT = "a".repeat(40)
const REPO = "enajx/PI-Lab"

/** Files are real; the tiny archives stand in for separately tested signed packages. */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-lab-prepare-beta-"))
  const stem = `PI-Lab-${VERSION}-arm64`
  const zip = Buffer.from("verified ZIP fixture")
  const dmg = Buffer.from("verified DMG fixture")
  writeFileSync(join(directory, `${stem}.zip`), zip)
  writeFileSync(join(directory, `${stem}.dmg`), dmg)
  writeFileSync(join(directory, `${stem}.zip.blockmap`), "ZIP blockmap fixture")
  writeFileSync(join(directory, `${stem}.dmg.blockmap`), "not an updater asset")
  writeFileSync(
    join(directory, "beta-mac.yml"),
    `version: ${VERSION}\nfiles:\n  - url: ${stem}.zip\n    sha512: ${createHash("sha512").update(zip).digest("base64")}\n    size: ${zip.length}\n  - url: ${stem}.dmg\n    sha512: ${createHash("sha512").update(dmg).digest("base64")}\n    size: ${dmg.length}\n`,
  )
  return {
    artifactDir: directory,
    version: VERSION,
    commit: COMMIT,
    previousTag: "v0.1.0-beta.3",
    repo: REPO,
  }
}

test("a real candidate produces exactly four checked release assets and pinned source notes", () => {
  const input = fixture()
  try {
    createBetaManifest(input)
    const manifest = validateBetaManifest(input.artifactDir)
    assert.equal(manifest.commit, COMMIT)
    assert.equal(manifest.tag, `v${VERSION}`)
    assert.equal(manifest.previousTag, "v0.1.0-beta.3")
    assert.deepEqual(
      manifest.assets.map(({ name }) => name).sort(),
      [
        `PI-Lab-${VERSION}-arm64.dmg`,
        `PI-Lab-${VERSION}-arm64.zip`,
        `PI-Lab-${VERSION}-arm64.zip.blockmap`,
        "beta-mac.yml",
      ].sort(),
    )
    assert.match(
      readFileSync(join(input.artifactDir, "release-notes.md"), "utf8"),
      new RegExp(COMMIT),
    )
  } finally {
    rmSync(input.artifactDir, { recursive: true })
  }
})

test("bad versions, non-main-commit identifiers and non-increasing Beta versions are rejected", () => {
  const input = fixture()
  try {
    for (const version of ["0.1.0", "0.1.0-beta.04", "0.1.0-beta.4;echo injected", "0.0.0-beta.1"])
      assert.throws(() => createBetaManifest({ ...input, version }), /version/i)
    assert.throws(() => createBetaManifest({ ...input, commit: "main" }), /commit/i)
    assert.throws(() => createBetaManifest({ ...input, previousTag: `v${VERSION}` }), /newer/i)
    assert.throws(() => createBetaManifest({ ...input, previousTag: "v0.2.0-beta.1" }), /newer/i)
  } finally {
    rmSync(input.artifactDir, { recursive: true })
  }
})

test("feed version and SHA-512 must match the candidate before a manifest is written", () => {
  const input = fixture()
  try {
    const feed = join(input.artifactDir, "beta-mac.yml")
    const original = readFileSync(feed, "utf8")
    writeFileSync(feed, original.replace(VERSION, "0.1.0-beta.2"))
    assert.throws(() => createBetaManifest(input), /version/i)
    writeFileSync(feed, original)
    writeFileSync(join(input.artifactDir, `PI-Lab-${VERSION}-arm64.zip`), "changed ZIP")
    assert.throws(() => createBetaManifest(input), /SHA-512|size/i)
  } finally {
    rmSync(input.artifactDir, { recursive: true })
  }
})

test("changed assets, notes, unsafe manifest paths and symbolic links cannot be published", () => {
  const input = fixture()
  try {
    createBetaManifest(input)
    const manifestPath = join(input.artifactDir, "prepare-beta.json")
    const originalManifest = readFileSync(manifestPath, "utf8")
    const manifest = JSON.parse(originalManifest)
    manifest.assets[0].name = "../outside.zip"
    writeFileSync(manifestPath, JSON.stringify(manifest))
    assert.throws(() => validateBetaManifest(input.artifactDir), /asset|path/i)
    writeFileSync(manifestPath, originalManifest)
    writeFileSync(join(input.artifactDir, "release-notes.md"), "changed notes")
    assert.throws(() => validateBetaManifest(input.artifactDir), /notes|checksum/i)
    createBetaManifest(input)
    const zip = join(input.artifactDir, `PI-Lab-${VERSION}-arm64.zip`)
    rmSync(zip)
    symlinkSync("beta-mac.yml", zip)
    assert.throws(() => validateBetaManifest(input.artifactDir), /symbolic|regular/i)
  } finally {
    rmSync(input.artifactDir, { recursive: true })
  }
})

test("an archive changed after preparation fails checksum validation", () => {
  const input = fixture()
  try {
    createBetaManifest(input)
    writeFileSync(join(input.artifactDir, `PI-Lab-${VERSION}-arm64.zip`), "modified ZIP fixture")
    assert.throws(() => validateBetaManifest(input.artifactDir), /checksum|size/i)
  } finally {
    rmSync(input.artifactDir, { recursive: true })
  }
})

/** Real CLI subprocess, mocked gh executable: publish needs no installed package dependencies. */
test("publish CLI runs from an isolated directory with Node built-ins only", () => {
  const input = fixture()
  const cli = mkdtempSync(join(tmpdir(), "pi-lab-publish-cli-"))
  try {
    createBetaManifest(input)
    for (const filename of ["prepare-beta.cjs", "public-release.cjs"])
      copyFileSync(join(__dirname, filename), join(cli, filename))
    const bin = join(cli, "bin")
    mkdirSync(bin)
    const calls = join(cli, "gh-call.json")
    writeFileSync(
      join(bin, "gh"),
      `#!${process.execPath}\nconst fs=require('node:fs'); const args=process.argv.slice(2); if(args[0]==='api'&&!args.includes('POST')) { process.stderr.write('HTTP 404'); process.exit(1); } if(args.includes('POST')) { process.stdout.write(JSON.stringify({object:{sha:'${COMMIT}'}})); } else { fs.writeFileSync(process.env.FAKE_GH_CALL, JSON.stringify(args)); process.stdout.write('https://github.com/${REPO}/releases/tag/v${VERSION}'); }\n`,
      { mode: 0o755 },
    )
    const output = execFileSync(
      process.execPath,
      [join(cli, "prepare-beta.cjs"), "publish", input.artifactDir, REPO],
      {
        cwd: cli,
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          FAKE_GH_CALL: calls,
        },
        encoding: "utf8",
      },
    )
    assert.match(output, /github.com\/enajx\/PI-Lab\/releases/)
    assert.ok(JSON.parse(readFileSync(calls, "utf8")).includes("--draft"))
  } finally {
    rmSync(input.artifactDir, { recursive: true })
    rmSync(cli, { recursive: true })
  }
})

/** Mocked GitHub boundary; real artifacts and argument validation still run. */
test("publishes only a draft prerelease at the exact source commit with the four checked assets", () => {
  const input = fixture()
  try {
    createBetaManifest(input)
    const calls = []
    const run = (args) => {
      calls.push(args)
      if (args[0] === "api" && args.includes("POST"))
        return JSON.stringify({ object: { sha: COMMIT } })
      if (args[0] === "api")
        throw Object.assign(new Error("not found"), { stderr: "HTTP 404", status: 1 })
      return "https://github.com/enajx/PI-Lab/releases/tag/v0.1.0-beta.4\n"
    }
    const url = publishBetaDraft({ artifactDir: input.artifactDir, repo: REPO }, run)
    assert.match(url, /releases\/tag\/v0\.1\.0-beta\.4/)
    const create = calls.find(([first]) => first === "release")
    assert.ok(create.includes("--draft"))
    assert.ok(create.includes("--prerelease"))
    assert.ok(create.includes("--verify-tag"))
    const tag = calls.find((args) => args.includes("POST"))
    assert.ok(tag.includes(`sha=${COMMIT}`))
    assert.equal(create[create.indexOf("--target") + 1], COMMIT)
    assert.equal(
      create.filter((arg) => arg.startsWith(input.artifactDir) && !arg.endsWith("release-notes.md"))
        .length,
      4,
    )
    assert.ok(!create.some((arg) => arg.endsWith(".dmg.blockmap")))
  } finally {
    rmSync(input.artifactDir, { recursive: true })
  }
})

/** Mocked GitHub boundary: no upload or tag change occurs on existing or uncertain state. */
test("existing releases/tags and network failures stop before draft creation", () => {
  const input = fixture()
  try {
    createBetaManifest(input)
    for (const existing of ["release", "tag", "network"]) {
      const calls = []
      const run = (args) => {
        calls.push(args)
        if (existing === "network")
          throw Object.assign(new Error("offline"), { stderr: "connection failed", status: 1 })
        if (existing === "release" || args[1].includes("git/ref/tags")) return "{}"
        throw Object.assign(new Error("not found"), { stderr: "HTTP 404", status: 1 })
      }
      assert.throws(
        () => publishBetaDraft({ artifactDir: input.artifactDir, repo: REPO }, run),
        /already exists|connection failed/i,
      )
      assert.ok(calls.every(([command]) => command === "api"))
    }
  } finally {
    rmSync(input.artifactDir, { recursive: true })
  }
})
