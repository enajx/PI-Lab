import { getSettingsOrDefaults, type PiLabDatabase } from "@pi-lab/local-db"
import { defaultPdfLatexInstallDir, installPdfLatex } from "../../latex/install"
import { probeLatexRuntimes } from "../../latex/runtime"
import type { AppContext } from "../context"
import { writeEditorSettings } from "../settings/settings"
import { publicProcedure, router } from "../trpc"

type InstallStage =
  | "idle"
  | "downloading"
  | "extracting"
  | "validating"
  | "registering"
  | "complete"
  | "failed"
interface InstallStatus {
  state: InstallStage
  progress: number | null
  message: string
  error: string | null
}
interface InstallJob {
  status: InstallStatus
  pending: boolean
}
const jobs = new WeakMap<PiLabDatabase, InstallJob>()

/** Keep installation progress separate for each app database, including isolated tests. */
function jobFor(ctx: AppContext): InstallJob {
  let job = jobs.get(ctx.db)
  if (!job) {
    job = { pending: false, status: { state: "idle", progress: null, message: "", error: null } }
    jobs.set(ctx.db, job)
  }
  return job
}

/** Download only after the explicit Settings action; report errors without changing provider. */
async function installFor(ctx: AppContext, job: InstallJob): Promise<void> {
  const available = await probeLatexRuntimes(ctx)
  if (!available.system.available) {
    const userHome = ctx.latexUserHome ?? ctx.skillsHomeDir
    await installPdfLatex({
      userHome,
      installDir: defaultPdfLatexInstallDir(userHome, process.platform),
      platform: process.platform,
      arch: process.arch,
      onProgress: (stage) => {
        const progress = { downloading: 10, extracting: 50, validating: 80, registering: 95 }[stage]
        const message = {
          downloading: "Downloading PDFLaTeX…",
          extracting: "Extracting PDFLaTeX…",
          validating: "Checking PDFLaTeX and latexmk…",
          registering: "Making commands available to other apps…",
        }[stage]
        job.status = { state: stage, progress, message, error: null }
      },
    })
  }
  writeEditorSettings(ctx.db, { latexProvider: "system" })
  job.status = {
    state: "complete",
    progress: 100,
    message: available.system.available
      ? "Using your existing system LaTeX installation."
      : "PDFLaTeX is ready. Restart other apps or open a new terminal to find its commands.",
    error: null,
  }
}

export const latexRouter = router({
  status: publicProcedure.query(async ({ ctx }) => {
    const runtimes = await probeLatexRuntimes(ctx)
    return {
      ...runtimes,
      provider: getSettingsOrDefaults(ctx.db).editor.latexProvider,
      installation: jobFor(ctx).status,
    }
  }),
  install: publicProcedure.mutation(({ ctx }) => {
    const job = jobFor(ctx)
    if (job.pending) return { started: false }
    job.pending = true
    job.status = {
      state: "downloading",
      progress: null,
      message: "Checking existing LaTeX tools…",
      error: null,
    }
    void installFor(ctx, job)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        job.status = {
          state: "failed",
          progress: null,
          message: "PDFLaTeX installation failed.",
          error: message,
        }
      })
      .finally(() => {
        job.pending = false
      })
    return { started: true }
  }),
})
