import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, mkdir, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { promisify } from "node:util"
import type { AppContext } from "../trpc/context"
import { defaultPdfLatexInstallDir } from "./install"

const execute = promisify(execFile)
export type LatexProvider = "bundled" | "system"
type RuntimeContext = Pick<
  AppContext,
  | "resolveAgentExecutable"
  | "getAgentLaunchEnvironment"
  | "skillsHomeDir"
  | "latexResourcesDir"
  | "latexDataDir"
  | "latexUserHome"
>
export interface LatexRuntime {
  provider: LatexProvider
  executable: string
  pdflatexPath: string | null
  env: Record<string, string>
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

/** Resolve only the selected compiler, with no implicit fallback to another provider. */
export async function resolveLatexRuntime(
  ctx: RuntimeContext,
  provider: LatexProvider,
): Promise<LatexRuntime> {
  const env: Record<string, string> = {
    ...(await ctx.getAgentLaunchEnvironment()),
    SYNCTEX_EDITOR: "",
    SYNCTEX_VIEWER: "",
  }
  if (provider === "bundled") {
    if (!ctx.latexResourcesDir)
      throw new Error(
        "Bundled Tectonic resources are unavailable. Rebuild PI Lab with its LaTeX runtime.",
      )
    const path = join(
      ctx.latexResourcesDir,
      `${process.platform}-${process.arch}`,
      process.platform === "win32" ? "tectonic.exe" : "tectonic",
    )
    if (!(await executable(path)))
      throw new Error(
        `Bundled Tectonic is unavailable for ${process.platform}/${process.arch}. Rebuild PI Lab or select system LaTeX in Settings.`,
      )
    const cache = join(ctx.latexDataDir ?? join(homedir(), ".pi-lab", "latex"), "cache")
    await mkdir(cache, { recursive: true })
    return {
      provider,
      executable: path,
      pdflatexPath: null,
      env: { ...env, TECTONIC_CACHE_DIR: cache },
    }
  }
  const [latexmk, pdflatex] = await Promise.all([
    ctx.resolveAgentExecutable("latexmk"),
    ctx.resolveAgentExecutable("pdflatex"),
  ])
  if (latexmk && pdflatex) return { provider, executable: latexmk, pdflatexPath: pdflatex, env }
  const shared = await sharedTools(ctx)
  if (shared)
    return {
      provider,
      executable: shared.latexmk,
      pdflatexPath: shared.pdflatex,
      env: { ...env, PATH: `${dirname(shared.latexmk)}${delimiter}${env.PATH ?? ""}` },
    }
  throw new Error(
    "System PDFLaTeX and latexmk are required. Install PDFLaTeX in Settings or choose bundled Tectonic.",
  )
}

/** Read compiler versions for Settings without blocking the UI on a build. */
export async function probeLatexRuntimes(ctx: RuntimeContext) {
  const probe = async (provider: LatexProvider) => {
    const result = await resolveLatexRuntime(ctx, provider)
      .then(async (runtime) => {
        const { stdout, stderr } = await execute(
          runtime.executable,
          provider === "bundled" ? ["--version"] : ["-v"],
          { env: runtime.env, timeout: 10_000, maxBuffer: 20_000 },
        )
        return {
          available: true,
          version:
            `${stdout}\n${stderr}`
              .trim()
              .split("\n")
              .find((line) => line.trim()) ?? null,
          path: runtime.executable,
          pdflatexPath: runtime.pdflatexPath,
          latexmkPath: provider === "system" ? runtime.executable : null,
          error: null,
        }
      })
      .catch((error: unknown) => ({
        available: false,
        version: null,
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
