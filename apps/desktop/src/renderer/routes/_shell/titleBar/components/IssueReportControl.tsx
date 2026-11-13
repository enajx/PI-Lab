import { Bug } from "lucide-react"
import { useRef, useState } from "react"
import { usePopupDismiss } from "../../../../components/usePopupDismiss"
import { useTranslate } from "../../../../i18n/language"
import {
  ISSUE_ACTION_LABELS,
  type IssueKind,
  useOpenIssueForm,
} from "../../../../issueReport/issueForms"

const KINDS: readonly IssueKind[] = ["bug", "feature"]

/** Title bar menu that opens the GitHub bug report or feature request form. */
export function IssueReportControl() {
  const t = useTranslate()
  const openIssueForm = useOpenIssueForm()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const label = t("Report an issue")

  usePopupDismiss(open, [hostRef], () => setOpen(false))

  const choose = (kind: IssueKind) => {
    setError(null)
    openIssueForm(kind).then(
      () => setOpen(false),
      (cause: unknown) => setError(`${t("Could not open the issue form")}: ${String(cause)}`),
    )
  }

  return (
    <div ref={hostRef} className="app-no-drag relative shrink-0">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="issue-report-control"
        title={label}
        data-feature-label={label}
        data-feature-help={t("Report a bug or request a feature on GitHub")}
        onClick={() => setOpen((current) => !current)}
        className="app-no-drag relative inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Bug className="size-4" aria-hidden />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={label}
          data-testid="issue-report-menu"
          className="absolute top-10 right-0 z-50 w-52 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl"
        >
          {KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              data-testid={`issue-report-${kind}`}
              onClick={() => choose(kind)}
              className="block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
            >
              {t(ISSUE_ACTION_LABELS[kind])}
            </button>
          ))}
          {error ? (
            <p role="alert" className="px-2 py-1.5 text-destructive text-xs">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
