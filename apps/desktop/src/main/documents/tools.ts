import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { delimiter, join } from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)

/** The document tools PI Lab renders with: Quarto (`quarto`) and MyST (`myst`, from the mystmd package). */
export type DocumentTool = "quarto" | "myst"

/** Folders searched after PATH, because a GUI app's PATH often lacks them. */
export const WELL_KNOWN_TOOL_DIRS: readonly string[] = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/Applications/quarto/bin",
]

/** A tool found on disk. `version` is null and `error` set when `--version` failed. */
export interface FoundDocumentTool {
  path: string
  version: string | null
  error: string | null
}

/** Where PI Lab's own install of a tool puts its command, inside `toolsDir`. */
export function piLabToolPath(toolsDir: string, tool: DocumentTool): string {
  if (tool === "quarto") return join(toolsDir, "quarto", "bin", "quarto")
  return join(toolsDir, "mystmd", "node_modules", ".bin", "myst")
}

async function isExecutable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  )
}

/**
 * Find a document tool: PI Lab's own install in `toolsDir` first, then each
 * folder of `env.PATH`, then `extraDirs`. Runs `<tool> --version` with `env` to
 * read the version. Returns null when the command is in none of these folders.
 */
export async function findDocumentTool(
  tool: DocumentTool,
  toolsDir: string,
  env: Record<string, string>,
  extraDirs: readonly string[],
): Promise<FoundDocumentTool | null> {
  const candidates = [
    piLabToolPath(toolsDir, tool),
    ...[...(env.PATH ?? "").split(delimiter).filter(Boolean), ...extraDirs].map((dir) =>
      join(dir, tool),
    ),
  ]
  for (const path of candidates) {
    if (!(await isExecutable(path))) continue
    return execute(path, ["--version"], { env, timeout: 30_000, maxBuffer: 1024 * 1024 }).then(
      ({ stdout }) => ({
        path,
        version: stdout.trim().split("\n")[0]?.trim() || null,
        error: null,
      }),
      (error: Error & { stderr?: string }) => ({
        path,
        version: null,
        error: `${error.message}${error.stderr ? `\n${error.stderr}` : ""}`.trim(),
      }),
    )
  }
  return null
}
