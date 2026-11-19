import { execFile, execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Helpers for the server bundle tests: build the bundle from the built app,
 * make variants of it (another version, a changed file), and run install.sh
 * with temp folders only. Nothing here touches `~/.pi-lab`,
 * `~/Library/LaunchAgents` or the real launchd label: every run gets a temp
 * HOME, `--no-launchd`, a temp prefix and a temp data folder.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_DIR = join(HERE, "..", "..")
export const DESKTOP_DIR = join(REPO_DIR, "apps", "desktop")
export const INSTALLER = join(DESKTOP_DIR, "scripts", "server-install", "install.sh")
const PACKAGE_SCRIPT = join(DESKTOP_DIR, "scripts", "package-server-bundle.cjs")

export interface BuiltBundle {
  tarball: string
  version: string
  build: string
}

/** A new temp folder (real path, as the installer resolves it). */
export async function tempDir(prefix: string): Promise<string> {
  return realpathSync(await mkdtemp(join(tmpdir(), prefix)))
}

/** Build the bundle for `version` from `apps/desktop/out/` and copy it into `into`. */
export function buildBundle(version: string, into: string): BuiltBundle {
  const stdout = execFileSync(process.execPath, [PACKAGE_SCRIPT, version], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  const built = stdout.trim().split("\n").at(-1) ?? ""
  const name = built.split("/").at(-1) ?? ""
  const tarball = join(into, name)
  execFileSync("/bin/cp", [built, `${built}.sha256`, into])
  const bundleDir = name.replace(/\.tar\.gz$/, "")
  const manifest = JSON.parse(
    execFileSync("/usr/bin/tar", ["-xzOf", tarball, `${bundleDir}/bundle.json`], {
      encoding: "utf8",
    }),
  ) as { build: string }
  return { tarball, version, build: manifest.build }
}

/**
 * Repack `source` as `version` with build id `build`, into `into`. `edit`
 * may change the unpacked bundle (its root folder) before packing.
 */
export function repackBundle(
  source: BuiltBundle,
  version: string,
  build: string,
  into: string,
  edit: ((root: string) => void) | null,
): BuiltBundle {
  const work = join(into, `.repack-${version}`)
  mkdirSync(work, { recursive: true })
  execFileSync("/usr/bin/tar", ["-xzf", source.tarball, "-C", work])
  const arch = process.arch
  const from = join(work, `pi-lab-server-${source.version}-darwin-${arch}`)
  const name = `pi-lab-server-${version}-darwin-${arch}`
  const root = join(work, name)
  renameSync(from, root)
  const launcher = join(root, "bin", "pi-lab-server")
  writeFileSync(
    launcher,
    readFileSync(launcher, "utf8")
      .replace(/PI_LAB_BUILD=\S+/, `PI_LAB_BUILD=${build}`)
      .replace(/PI_LAB_VERSION=\S+/, `PI_LAB_VERSION=${version}`),
  )
  writeFileSync(
    join(root, "bundle.json"),
    `${JSON.stringify({ version, build, platform: "darwin", arch }, null, 2)}\n`,
  )
  edit?.(root)
  const tarball = join(into, `${name}.tar.gz`)
  execFileSync("/usr/bin/tar", ["-czf", tarball, "-C", work, name], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  })
  writeSha256(tarball)
  execFileSync("/bin/rm", ["-rf", work])
  return { tarball, version, build }
}

/** Write `<file>.sha256` as the bundle script does. */
export function writeSha256(file: string): void {
  const sum = createHash("sha256").update(readFileSync(file)).digest("hex")
  writeFileSync(`${file}.sha256`, `${sum}  ${file.split("/").at(-1)}\n`)
}

/** The environment of an install run: temp HOME, test mode, the system tools only. */
export function installEnv(home: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    SHELL: "/bin/zsh",
    PI_LAB_TEST_MODE: "1",
    ...extra,
  }
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** Run install.sh with `args`; resolves with its exit code and output. */
export function runInstall(
  installer: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile("/bin/sh", [installer, ...args], { env }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0
      resolve({ code, stdout, stderr })
    })
  })
}

/** Stop every process whose command line names `root` (servers, daemons, agents of a test). */
export function killProcessesUnder(root: string): void {
  spawnSync("/usr/bin/pkill", ["-KILL", "-f", root])
}
