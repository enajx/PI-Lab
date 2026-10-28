import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, expect, test } from "vitest"
import { installPdfLatex, registerSharedPdfLatex } from "./install"

const run = promisify(execFile)
const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})
async function fixture() {
  const userHome = await mkdtemp(path.join(tmpdir(), "pi-lab-installer-test-"))
  directories.push(userHome)
  const source = path.join(userHome, "source")
  const binDir = path.join(source, "TinyTeX/bin/universal-darwin")
  await mkdir(binDir, { recursive: true })
  for (const command of ["pdflatex", "latexmk", "synctex"]) {
    await writeFile(path.join(binDir, command), "#!/bin/sh\necho test-version\n", { mode: 0o755 })
  }
  const archive = path.join(userHome, "fixture.tar.xz")
  await run("tar", ["-cJf", archive, "-C", source, "TinyTeX"])
  const bytes = await readFile(archive)
  return {
    userHome,
    installDir: path.join(userHome, "Library/TinyTeX"),
    platform: "darwin" as const,
    arch: "arm64" as const,
    dependencies: {
      artifact: {
        url: "https://example.test/tinytex.tar.xz",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        format: "tar" as const,
      },
      download: async () => bytes,
    },
  }
}
test("installs from verified archive, runs tools, and exposes a shared shell PATH", async () => {
  const options = await fixture()
  const stages: string[] = []
  const result = await installPdfLatex({ ...options, onProgress: (stage) => stages.push(stage) })
  expect(stages).toEqual(["downloading", "extracting", "validating", "registering"])
  expect(result.pdflatexPath).toBe(path.join(result.binDir, "pdflatex"))
  expect(result.reusedExisting).toBe(false)
  const profile = await readFile(path.join(options.userHome, ".zprofile"), "utf8")
  expect(profile).toContain(result.binDir)
  const shell = await run(
    "/bin/sh",
    ["-c", `. '${options.userHome}/.profile'; command -v pdflatex`],
    { env: { PATH: "/usr/bin:/bin" } },
  )
  expect(shell.stdout.trim()).toBe(result.pdflatexPath)
  expect((await installPdfLatex(options)).reusedExisting).toBe(true)
  expect(await readFile(path.join(options.userHome, ".zprofile"), "utf8")).toBe(profile)
})
test("rejects corrupted downloads without installing or registering", async () => {
  const options = await fixture()
  options.dependencies.download = async () => Buffer.from("corrupt")
  await expect(installPdfLatex(options)).rejects.toThrow(/verification/)
  await expect(readFile(path.join(options.userHome, ".profile"))).rejects.toThrow()
})
test("refuses to overwrite an existing incomplete installation", async () => {
  const options = await fixture()
  await mkdir(options.installDir, { recursive: true })
  await writeFile(path.join(options.installDir, "keep.txt"), "existing")
  await expect(installPdfLatex(options)).rejects.toThrow(/existing/)
  expect(await readFile(path.join(options.installDir, "keep.txt"), "utf8")).toBe("existing")
})
test("keeps existing shell configuration and command precedence", async () => {
  const options = await fixture()
  const profile = path.join(options.userHome, ".profile")
  await writeFile(profile, "# user's configuration\nexport EXISTING=1\n")
  await registerSharedPdfLatex({
    binDir: "/tmp/tex 'quoted'/bin",
    userHome: options.userHome,
    platform: "darwin",
  })
  expect(await readFile(profile, "utf8")).toContain("# user's configuration\nexport EXISTING=1\n")
  expect(
    (
      await run("/bin/sh", ["-c", `. '${profile}'; printf '%s' "$PATH"`], {
        env: { PATH: "/usr/bin:/bin" },
      })
    ).stdout,
  ).toBe("/usr/bin:/bin:/tmp/tex 'quoted'/bin")
})

test("failed tool validation leaves the final location and shared PATH untouched", async () => {
  const options = await fixture()
  const source = path.join(options.userHome, "source")
  await writeFile(
    path.join(source, "TinyTeX/bin/universal-darwin/latexmk"),
    "#!/bin/sh\necho 'Perl is missing' >&2\nexit 1\n",
    { mode: 0o755 },
  )
  const archive = path.join(options.userHome, "invalid.tar.xz")
  await run("tar", ["-cJf", archive, "-C", source, "TinyTeX"])
  const bytes = await readFile(archive)
  options.dependencies.artifact.sha256 = createHash("sha256").update(bytes).digest("hex")
  options.dependencies.artifact.size = bytes.length
  options.dependencies.download = async () => bytes
  await expect(installPdfLatex(options)).rejects.toThrow(/Perl is missing/)
  await expect(
    readFile(path.join(options.installDir, "bin/universal-darwin/pdflatex")),
  ).rejects.toThrow()
  await expect(readFile(path.join(options.userHome, ".profile"))).rejects.toThrow()
})

test("reuses a healthy existing installation without downloading", async () => {
  const options = await fixture()
  await installPdfLatex(options)
  options.dependencies.download = async () => {
    throw new Error("must not download")
  }
  expect((await installPdfLatex(options)).reusedExisting).toBe(true)
})

test("refuses a competing installer without modifying its lock", async () => {
  const options = await fixture()
  await mkdir(path.dirname(options.installDir), { recursive: true })
  await writeFile(`${options.installDir}.pi-lab-install.lock`, "another installer")
  await expect(installPdfLatex(options)).rejects.toThrow(
    /Remove this lock manually only when no installer is running/,
  )
  expect(await readFile(`${options.installDir}.pi-lab-install.lock`, "utf8")).toBe(
    "another installer",
  )
})

test("TinyTeX without the optional SyncTeX CLI still installs PDFLaTeX and latexmk", async () => {
  const options = await fixture()
  const source = path.join(options.userHome, "source")
  await rm(path.join(source, "TinyTeX/bin/universal-darwin/synctex"))
  const archive = path.join(options.userHome, "without-synctex.tar.xz")
  await run("tar", ["-cJf", archive, "-C", source, "TinyTeX"])
  const bytes = await readFile(archive)
  options.dependencies.artifact.sha256 = createHash("sha256").update(bytes).digest("hex")
  options.dependencies.artifact.size = bytes.length
  options.dependencies.download = async () => bytes
  const installation = await installPdfLatex(options)
  expect(installation.synctexPath).toBeNull()
  expect(installation.pdflatexPath).toContain("pdflatex")
})

test("recovers a lock owned by a crashed process and completes installation", async () => {
  const options = await fixture()
  const child = await run(process.execPath, ["-e", "console.log(process.pid)"])
  const deadPid = Number(child.stdout.trim())
  const lockPath = `${options.installDir}.pi-lab-install.lock`
  await mkdir(lockPath, { recursive: true })
  await writeFile(path.join(lockPath, `${deadPid}-dead-test.owner`), "")
  expect((await installPdfLatex(options)).reusedExisting).toBe(false)
  await expect(readFile(path.join(lockPath, `${deadPid}-dead-test.owner`))).rejects.toThrow()
})

test("preserves an active process's installation lock", async () => {
  const options = await fixture()
  const lockPath = `${options.installDir}.pi-lab-install.lock`
  await mkdir(lockPath, { recursive: true })
  const ownerPath = path.join(lockPath, `${process.pid}-active-test.owner`)
  await writeFile(ownerPath, "active")
  await expect(installPdfLatex(options)).rejects.toThrow(/Another PDFLaTeX installer is running/)
  expect(await readFile(ownerPath, "utf8")).toBe("active")
})

test("empty legacy locks report their path and remain untouched", async () => {
  const options = await fixture()
  const lockPath = `${options.installDir}.pi-lab-install.lock`
  await mkdir(path.dirname(lockPath), { recursive: true })
  await writeFile(lockPath, "")
  await expect(installPdfLatex(options)).rejects.toThrow(lockPath)
  expect(await readFile(lockPath, "utf8")).toBe("")
})
