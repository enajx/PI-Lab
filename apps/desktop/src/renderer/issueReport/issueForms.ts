import { useQueryClient } from "@tanstack/react-query"
import { useTRPC } from "../trpc/react"

/** The two GitHub issue forms in `.github/ISSUE_TEMPLATE/` (at the repo root). */
export type IssueKind = "bug" | "feature"

export interface AppEnvironment {
  version: string
  channel: "alpha" | "beta" | "stable"
  /** Short git commit of an Alpha build; null for Beta and Stable. */
  commit: string | null
  macosVersion: string
}

const NEW_ISSUE_URL = "https://github.com/enajx/PI-Lab/issues/new"

const TEMPLATES: Record<IssueKind, string> = {
  bug: "bug_report.yml",
  feature: "feature_request.yml",
}

const CHANNEL_LABELS: Record<"beta" | "stable", string> = {
  beta: "Beta",
  stable: "Stable",
}

/** Labels for the two actions, shared by the title bar menu, palette and Settings. */
export const ISSUE_ACTION_LABELS: Record<IssueKind, string> = {
  bug: "Report a bug",
  feature: "Request a feature",
}

/** Several Alpha builds share a version, so they name their commit instead. */
function appLabel(environment: AppEnvironment): string {
  if (environment.channel === "alpha") {
    if (!environment.commit) throw new Error("Alpha build has no commit")
    return `PI Lab Alpha ${environment.commit}`
  }
  return `PI Lab ${environment.version} (${CHANNEL_LABELS[environment.channel]})`
}

/** URL of the issue form for `kind`, with its `environment` field prefilled. */
export function issueFormUrl(kind: IssueKind, environment: AppEnvironment): string {
  const params = new URLSearchParams({
    template: TEMPLATES[kind],
    environment: `${appLabel(environment)}, macOS ${environment.macosVersion}`,
  })
  return `${NEW_ISSUE_URL}?${params.toString()}`
}

/**
 * Returns a function that reads the app environment from main and opens the issue
 * form in the browser (the main window sends https window opens to the browser).
 * The returned promise rejects if the environment cannot be read.
 */
export function useOpenIssueForm(): (kind: IssueKind) => Promise<void> {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  return async (kind) => {
    const environment = await queryClient.fetchQuery(trpc.system.appInfo.queryOptions())
    window.open(issueFormUrl(kind, environment), "_blank")
  }
}
