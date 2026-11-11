import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, mkdir, readdir } from "node:fs/promises"
import { delimiter, dirname, join } from "node:path"
import { promisify } from "node:util"
import type { AppContext } from "../trpc/context"
import { defaultPdfLatexInstallDir } from "./install"

const execute = promisify(execFile)
export type LatexProvider = "auto" | "bundled" | "system"
/** The compiler a build actually uses. */
export type LatexEngine = "bundled" | "system"
type RuntimeContext = Pick<
  AppContext,
  | "resolveAgentExecutable"
  | "getAgentLaunchEnvironment"
  | "skillsHomeDir"
  | "latexResourcesDir"
  | "latexCacheDir"
  | "latexUserHome"
>
export interface LatexRuntime {
  /** The compiler used; never "auto". */
  provider: LatexEngine
  executable: string
  pdflatexPath: string | null
  env: Record<string, string>
  /** Tectonic's package cache folder (bundled only), or null for system LaTeX. */
  cacheDir: string | null
}

/**
 * Per-user folder for Tectonic's downloaded TeX packages. It is outside PI
 * Lab's data folder, so the Alpha reset (which archives the whole data folder)
 * keeps it, and all channels share it because the packages are the same. In
 * test mode it stays at `<dataDir>/latex/cache`, so tests and e2e runs never
 * touch the user's cache and can link that folder to a shared test cache.
 * macOS: `~/Library/Caches/PI Lab/tectonic`; Windows: `%LOCALAPPDATA%\PI Lab\tectonic`;
 * others: `$XDG_CACHE_HOME/pi-lab/tectonic` (default `~/.cache`).
 */
export function tectonicCacheDir(
  testMode: boolean,
  dataDir: string,
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
): string {
  if (testMode) return join(dataDir, "latex", "cache")
  if (platform === "darwin") return join(home, "Library", "Caches", "PI Lab", "tectonic")
  if (platform === "win32") {
    return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "PI Lab", "tectonic")
  }
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "pi-lab", "tectonic")
}

/** Test executability without starting a shell. */
async function executable(path: string): Promise<string | null> {
  return access(path, constants.X_OK).then(
    () => path,
    () => null,
  )
}

/** Find the shared per-user TinyTeX binaries, including immediately after installation. */
async function sharedTools(
  ctx: RuntimeContext,
): Promise<{ latexmk: string; pdflatex: string } | null> {
  const root = join(
    defaultPdfLatexInstallDir(ctx.latexUserHome ?? ctx.skillsHomeDir, process.platform),
    "bin",
  )
  const entries = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  const directories =
    process.platform === "win32"
      ? [join(root, "windows")]
      : entries.map((entry) => join(root, entry))
  const suffix = process.platform === "win32" ? ".exe" : ""
  for (const directory of directories) {
    const [latexmk, pdflatex] = await Promise.all([
      executable(join(directory, `latexmk${suffix}`)),
      executable(join(directory, `pdflatex${suffix}`)),
    ])
    if (latexmk && pdflatex) return { latexmk, pdflatex }
  }
  return null
}

/** Bundled Tectonic, or the reason it cannot be used. */
async function bundledRuntime(
  ctx: RuntimeContext,
  env: Record<string, string>,
): Promise<LatexRuntime | string> {
  if (!ctx.latexResourcesDir)
    return "Bundled Tectonic resources are unavailable. Rebuild PI Lab with its LaTeX runtime."
  const path = join(
    ctx.latexResourcesDir,
    `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "tectonic.exe" : "tectonic",
  )
  if (!(await executable(path)))
    return `Bundled Tectonic is unavailable for ${process.platform}/${process.arch}. Rebuild PI Lab or select system LaTeX in Settings.`
  const cache = ctx.latexCacheDir
  if (!cache) return "No Tectonic package cache folder is configured."
  await mkdir(cache, { recursive: true })
  return {
    provider: "bundled",
    executable: path,
    pdflatexPath: null,
    env: { ...env, TECTONIC_CACHE_DIR: cache },
    cacheDir: cache,
  }
}

/** System pdflatex + latexmk from PATH or the shared TinyTeX install, or null when not found. */
async function systemRuntime(
  ctx: RuntimeContext,
  env: Record<string, string>,
): Promise<LatexRuntime | null> {
  const [latexmk, pdflatex] = await Promise.all([
    ctx.resolveAgentExecutable("latexmk"),
    ctx.resolveAgentExecutable("pdflatex"),
  ])
  if (latexmk && pdflatex)
    return { provider: "system", executable: latexmk, pdflatexPath: pdflatex, env, cacheDir: null }
  const shared = await sharedTools(ctx)
  if (!shared) return null
  return {
    provider: "system",
    executable: shared.latexmk,
    pdflatexPath: shared.pdflatex,
    env: { ...env, PATH: `${dirname(shared.latexmk)}${delimiter}${env.PATH ?? ""}` },
    cacheDir: null,
  }
}

const SYSTEM_MISSING =
  "System PDFLaTeX and latexmk are required. Install PDFLaTeX in Settings or choose bundled Tectonic."

/**
 * Resolve the compiler for a provider setting. "bundled" and "system" use only
 * that compiler, with no fallback. "auto" uses system LaTeX when it is found,
 * otherwise bundled Tectonic. The returned `provider` is the compiler used.
 */
export async function resolveLatexRuntime(
  ctx: RuntimeContext,
  provider: LatexProvider,
): Promise<LatexRuntime> {
  const env: Record<string, string> = {
    ...(await ctx.getAgentLaunchEnvironment()),
    SYNCTEX_EDITOR: "",
    SYNCTEX_VIEWER: "",
  }
  if (provider === "system") {
    const system = await systemRuntime(ctx, env)
    if (!system) throw new Error(SYSTEM_MISSING)
    return system
  }
  if (provider === "auto") {
    const system = await systemRuntime(ctx, env)
    if (system) return system
  }
  const bundled = await bundledRuntime(ctx, env)
  if (typeof bundled !== "string") return bundled
  if (provider === "auto")
    throw new Error(
      `No LaTeX engine is available. System PDFLaTeX and latexmk were not found (install TinyTeX from the LaTeX Editor footer or Settings > LaTeX), and bundled Tectonic cannot be used: ${bundled}`,
    )
  throw new Error(bundled)
}

/**
 * Short name of a compiler for the LaTeX Editor footer: "Tectonic", or the
 * system distribution from the pdflatex version line ("TeX Live 2026",
 * "MiKTeX"), else "System LaTeX".
 */
export function latexEngineName(engine: LatexEngine, version: string | null): string {
  if (engine === "bundled") return "Tectonic"
  const match = version?.match(/\b(TeX Live \d{4}|MiKTeX)\b/)
  return match?.[1] ?? "System LaTeX"
}

/** Read compiler versions for Settings and the LaTeX Editor footer without blocking the UI on a build. */
export async function probeLatexRuntimes(ctx: RuntimeContext) {
  const probe = async (provider: LatexEngine) => {
    const result = await resolveLatexRuntime(ctx, provider)
      .then(async (runtime) => {
        // For system LaTeX, pdflatex's version line names the distribution (e.g. TeX Live 2026).
        const { stdout, stderr } = await execute(
          runtime.pdflatexPath ?? runtime.executable,
          ["--version"],
          { env: runtime.env, timeout: 10_000, maxBuffer: 20_000 },
        )
        const version =
          `${stdout}\n${stderr}`
            .trim()
            .split("\n")
            .find((line) => line.trim()) ?? null
        return {
          available: true,
          version,
          name: latexEngineName(provider, version),
          path: runtime.executable,
          pdflatexPath: runtime.pdflatexPath,
          latexmkPath: provider === "system" ? runtime.executable : null,
          error: null,
        }
      })
      .catch((error: unknown) => ({
        available: false,
        version: null,
        name: latexEngineName(provider, null),
        path: null,
        pdflatexPath: null,
        latexmkPath: null,
        error: error instanceof Error ? error.message : String(error),
      }))
    return result
  }
  const [bundled, system] = await Promise.all([probe("bundled"), probe("system")])
  return { bundled, system }
}
