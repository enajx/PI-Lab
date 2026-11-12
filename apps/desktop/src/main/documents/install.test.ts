import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, test } from "vitest"
import { installMystmd, installQuarto, MYSTMD_VERSION, swapInto } from "./install"
import { piLabToolPath } from "./tools"

/**
 * Installers, with stand-ins: a small tar.gz shaped like the Quarto macOS
 * release (its `bin/quarto` is a shell script), and a stand-in `npm` script.
 * Nothing is downloaded.
 */

const run = promisify(execFile)
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-lab-doc-install-"))
  directories.push(dir)
  return dir
}

/** A tar.gz with `./bin/quarto` and `./share/`, like quarto-<version>-macos.tar.gz. */
async function quartoArchive(): Promise<Buffer> {
  const source = await tempDir()
  await mkdir(join(source, "bin"))
  await mkdir(join(source, "share"))
  await writeFile(join(source, "bin", "quarto"), "#!/bin/sh\necho 1.11.9\n", { mode: 0o755 })
  const archive = join(await tempDir(), "quarto.tar.gz")
  await run("tar", ["-czf", archive, "-C", source, "."])
  return readFile(archive)
}

describe("installQuarto", () => {
  test("installs a verified archive into the tools folder and checks the command runs", async () => {
    const toolsDir = join(await tempDir(), "tools")
    const bytes = await quartoArchive()
    const stages: string[] = []

    const path = await installQuarto({
      toolsDir,
      platform: "darwin",
      artifact: {
        url: "https://example.test/quarto.tar.gz",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      download: async () => bytes,
      onProgress: (stage) => stages.push(stage),
    })

    expect(path).toBe(piLabToolPath(toolsDir, "quarto"))
    expect((await run(path, ["--version"])).stdout.trim()).toBe("1.11.9")
    expect(stages).toEqual(["downloading", "extracting", "validating"])
  })

  test("refuses an archive whose digest does not match, and installs nothing", async () => {
    const toolsDir = join(await tempDir(), "tools")
    const bytes = await quartoArchive()

    await expect(
      installQuarto({
        toolsDir,
        platform: "darwin",
        artifact: {
          url: "https://example.test/q.tar.gz",
          size: bytes.length,
          sha256: "0".repeat(64),
        },
        download: async () => bytes,
        onProgress: () => {},
      }),
    ).rejects.toThrow(/verification failed/)
    await expect(readFile(piLabToolPath(toolsDir, "quarto"))).rejects.toThrow()
  })

  test("says to install Quarto by hand on other systems", async () => {
    const bytes = await quartoArchive()
    await expect(
      installQuarto({
        toolsDir: join(await tempDir(), "tools"),
        platform: "linux",
        artifact: { url: "https://example.test/q.tar.gz", size: bytes.length, sha256: "" },
        download: async () => bytes,
        onProgress: () => {},
      }),
    ).rejects.toThrow(/macOS/)
  })
})

describe("swapInto", () => {
  test("replaces the old install with the new one", async () => {
    const dir = await tempDir()
    await mkdir(join(dir, "new"))
    await writeFile(join(dir, "new", "version"), "2")
    await mkdir(join(dir, "tool"))
    await writeFile(join(dir, "tool", "version"), "1")
    await swapInto(join(dir, "new"), join(dir, "tool"))
    expect(await readFile(join(dir, "tool", "version"), "utf8")).toBe("2")
  })

  test("a failed move keeps the old install in place", async () => {
    const dir = await tempDir()
    await mkdir(join(dir, "tool"))
    await writeFile(join(dir, "tool", "version"), "1")
    // The staged folder is missing, so moving it in fails.
    await expect(swapInto(join(dir, "missing"), join(dir, "tool"))).rejects.toThrow()
    expect(await readFile(join(dir, "tool", "version"), "utf8")).toBe("1")
  })
})

describe("installMystmd", () => {
  test("runs npm install with the PI Lab tools folder as its prefix", async () => {
    const toolsDir = join(await tempDir(), "tools")
    const bin = await tempDir()
    const npm = join(bin, "npm")
    // Stand-in npm: records its arguments and creates the myst command npm would link.
    await writeFile(
      npm,
      `#!/bin/sh\necho "$@" > "${bin}/args"\nmkdir -p "$3/node_modules/.bin"\nprintf '#!/bin/sh\\necho v1.12.0\\n' > "$3/node_modules/.bin/myst"\nchmod +x "$3/node_modules/.bin/myst"\n`,
    )
    await chmod(npm, 0o755)

    const path = await installMystmd({
      toolsDir,
      npmPath: npm,
      env: { PATH: `${bin}:/usr/bin:/bin` },
      onProgress: () => {},
    })

    expect(path).toBe(piLabToolPath(toolsDir, "myst"))
    const args = (await readFile(join(bin, "args"), "utf8")).trim().split(" ")
    expect(args[0]).toBe("install")
    expect(args[1]).toBe("--prefix")
    expect(args[2]?.startsWith(join(toolsDir, "mystmd.pi-lab-stage-"))).toBe(true)
    expect(args.slice(3)).toEqual([`mystmd@${MYSTMD_VERSION}`, "--no-audit", "--no-fund"])
    expect(MYSTMD_VERSION).toBe("1.12.0")
    expect((await run(path, ["--version"])).stdout.trim()).toBe("v1.12.0")
  })

  test("a failed npm install keeps the previous install", async () => {
    const toolsDir = join(await tempDir(), "tools")
    const old = piLabToolPath(toolsDir, "myst")
    await mkdir(join(old, ".."), { recursive: true })
    await writeFile(old, "#!/bin/sh\necho v1.0.0\n", { mode: 0o755 })
    const bin = await tempDir()
    const npm = join(bin, "npm")
    await writeFile(npm, "#!/bin/sh\necho 'npm ERR! network down' >&2\nexit 1\n")
    await chmod(npm, 0o755)
    await expect(
      installMystmd({
        toolsDir,
        npmPath: npm,
        env: { PATH: `${bin}:/usr/bin:/bin` },
        onProgress: () => {},
      }),
    ).rejects.toThrow(/network down/)
    expect((await run(old, ["--version"])).stdout.trim()).toBe("v1.0.0")
  })

  test("says Node.js is needed when npm is not found", async () => {
    await expect(
      installMystmd({
        toolsDir: join(await tempDir(), "tools"),
        npmPath: null,
        env: { PATH: "/usr/bin:/bin" },
        onProgress: () => {},
      }),
    ).rejects.toThrow(/Node\.js/)
  })

  test("shows npm's output when npm fails", async () => {
    const bin = await tempDir()
    const npm = join(bin, "npm")
    await writeFile(npm, "#!/bin/sh\necho 'npm ERR! network down' >&2\nexit 1\n")
    await chmod(npm, 0o755)
    await expect(
      installMystmd({
        toolsDir: join(await tempDir(), "tools"),
        npmPath: npm,
        env: { PATH: `${bin}:/usr/bin:/bin` },
        onProgress: () => {},
      }),
    ).rejects.toThrow(/network down/)
  })
})
