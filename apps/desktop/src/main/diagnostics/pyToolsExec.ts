import { execFile } from "node:child_process"
import { promisify } from "node:util"

/**
 * Injectable exec seam for the Python diagnostics runners (AGENTS.md §14). The
 * runners shell out to the Astral CLIs (`ty` / `pyrefly` / `ruff`) **one-shot**
 * per save (TODO "Built-in editor" — one-shot CLI, not LSP). They never call
 * `node:child_process` directly: they go through this function so the diagnostics
 * router's tests inject a deterministic fake (canned ruff-JSON / ty output, plus
 * a "binary missing" branch) and need no `uv` installed (AGENTS.md §14 —
 * determinism without credentials/tooling).
 *
 * The live implementation runs the tool via `uvx` ({@link livePyToolsExec}); the
 * abstraction is "given a command + args + cwd, give me stdout/stderr/exit or a
 * `notFound` flag", which is all the runners need.
 */

/**
 * Outcome of one tool invocation. **Never throws** for ordinary outcomes: a tool
 * that exits non-zero because it *found* diagnostics (ruff/ty/pyrefly all do) is
 * a normal result, surfaced via `code` + the captured streams; a tool that could
 * not be launched at all (binary absent / unspawnable) is the typed
 * `notFound: true` branch the runners turn into a tooling-gap signal.
 */
export interface PyToolExecResult {
  /** stdout text (where ruff JSON / ty concise / pyrefly JSON land). */
  stdout: string
  /** stderr text (pyrefly's INFO summary, error banners). */
  stderr: string
  /** Process exit code, or `null` if it was killed by a signal / never ran. */
  code: number | null
  /** `true` iff the binary couldn't be found/launched (e.g. `uv` not installed). */
  notFound: boolean
}

/**
 * Run one Python tool. `tool` is the logical tool name (`ty` | `pyrefly` |
 * `ruff`); `args` are the tool-specific arguments (the file path + format flags).
 * `cwd` is the workspace working dir so the tool discovers the project's config /
 * virtual env. Implementations resolve a usable runtime (the live one prefixes
 * `uvx`) and **must not throw** for a missing binary — they set `notFound`.
 */
export type PyToolsExec = (params: {
  tool: "ty" | "pyrefly" | "ruff"
  args: readonly string[]
  cwd: string
}) => Promise<PyToolExecResult>

const execFileAsync = promisify(execFile)

/** Hard ceiling so a wedged check can't hang the save path indefinitely. */
const EXEC_TIMEOUT_MS = 30_000

/** Cap captured output so a pathological run can't blow up memory. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/**
 * Live exec (AGENTS.md §1, TODO "Built-in editor"): run the tool through `uvx`
 * (`uvx ty …` / `uvx pyrefly …` / `uvx ruff …`), which provisions the binary on
 * demand and ships with `uv`. The tool's own non-zero exit (diagnostics found) is
 * captured, not thrown; only a genuinely unspawnable command (`uv`/`uvx` not on
 * PATH → `ENOENT`) becomes `notFound: true`, the graceful "tools absent" path.
 */
export const livePyToolsExec: PyToolsExec = async ({ tool, args, cwd }) => {
  try {
    const { stdout, stderr } = await execFileAsync("uvx", [tool, ...args], {
      cwd,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    })
    return { stdout, stderr, code: 0, notFound: false }
  } catch (error) {
    return fromExecError(error)
  }
}

/**
 * Normalize an `execFile` rejection. `execFile` rejects both when the child
 * exits non-zero (its `stdout`/`stderr`/`code` are attached — a normal "found
 * diagnostics" result) and when it can't spawn at all (`ENOENT`). Distinguish
 * them: `ENOENT` → `notFound`; anything else with attached output → a real run
 * whose streams we keep so the parsers can still read them.
 */
function fromExecError(error: unknown): PyToolExecResult {
  const e = error as {
    code?: unknown
    stdout?: unknown
    stderr?: unknown
  }

  if (e?.code === "ENOENT") {
    return { stdout: "", stderr: "", code: null, notFound: true }
  }

  const stdout = typeof e?.stdout === "string" ? e.stdout : ""
  const stderr = typeof e?.stderr === "string" ? e.stderr : ""
  const code = typeof e?.code === "number" ? e.code : null
  return { stdout, stderr, code, notFound: false }
}
