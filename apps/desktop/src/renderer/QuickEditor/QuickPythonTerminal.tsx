import { Terminal } from "../Terminal"

/** Attach the existing terminal to one Python run below Quick Editor. */
export function QuickPythonTerminal({
  sessionId,
  fileName,
  onClose,
}: {
  sessionId: string
  fileName: string
  onClose: () => void
}) {
  return (
    <section
      data-testid="quick-python-terminal"
      className="flex h-56 shrink-0 flex-col border-border border-t bg-background"
    >
      <div className="flex h-7 shrink-0 items-center justify-between border-border border-b bg-muted/30 px-3 text-muted-foreground text-xs">
        <span className="truncate">Run {fileName}</span>
        <button
          type="button"
          data-testid="quick-python-terminal-close"
          aria-label="Close run terminal"
          onClick={onClose}
          className="rounded px-1 hover:bg-accent hover:text-foreground"
        >
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <Terminal key={sessionId} inputKind="terminal" sessionId={sessionId} />
      </div>
    </section>
  )
}
