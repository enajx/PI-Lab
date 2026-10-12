import { fuzzyMatch, highlightSegments } from "@pi-lab/shared/search/fuzzy"
import { cn } from "@pi-lab/ui"
import { useEffect, useMemo, useRef, useState } from "react"
import { type PaletteCommand, usePaletteCommands } from "./usePaletteCommands"

interface CommandPaletteProps {
  /** Dismiss the palette without running anything. */
  onClose: () => void
}

/** A command paired with the match positions to highlight in its label. */
interface RankedCommand {
  command: PaletteCommand
  positions: number[]
}

/**
 * The `⌘P` command palette (TODO "Command palette on ⌘P"): a centered overlay that
 * fuzzy-searches **commands + projects** (NOT files — file quick-open lives on ⌘F).
 * Typing ranks entries by the shared `@pi-lab/shared` fuzzy scorer with match
 * highlighting; ↑/↓ move the highlight, Enter runs the highlighted entry, Esc/backdrop
 * dismiss. Mounted app-globally by the shell so it works from any surface. With an empty
 * query it shows every entry in registry order (navigations, view toggles, then projects).
 */
export function CommandPalette({ onClose }: CommandPaletteProps) {
  const commands = usePaletteCommands()
  const [query, setQuery] = useState("")
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const ranked = useMemo<RankedCommand[]>(() => {
    const q = query.trim()
    if (!q) return commands.map((command) => ({ command, positions: [] }))
    return commands
      .map((command) => ({ command, match: fuzzyMatch(q, command.label) }))
      .filter(
        (
          entry,
        ): entry is { command: PaletteCommand; match: { score: number; positions: number[] } } =>
          entry.match !== null,
      )
      .sort((a, b) => b.match.score - a.match.score)
      .map((entry) => ({ command: entry.command, positions: entry.match.positions }))
  }, [query, commands])

  // Keep the highlight in range as the result set shrinks/changes.
  const clampedHighlight = Math.min(highlight, Math.max(ranked.length - 1, 0))

  // Reset to the top whenever the query changes so Enter targets the best match.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed to the query changing
  useEffect(() => {
    setHighlight(0)
  }, [query])

  // Scroll the highlighted row into view as the user arrows through.
  useEffect(() => {
    const list = listRef.current
    const row = list?.querySelector<HTMLElement>(`[data-index="${clampedHighlight}"]`)
    row?.scrollIntoView({ block: "nearest" })
  }, [clampedHighlight])

  const choose = (index: number) => {
    const entry = ranked[index]
    if (!entry) return
    onClose()
    entry.command.run()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault()
      onClose()
    } else if (event.key === "ArrowDown") {
      event.preventDefault()
      setHighlight(Math.min(clampedHighlight + 1, Math.max(ranked.length - 1, 0)))
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setHighlight(Math.max(clampedHighlight - 1, 0))
    } else if (event.key === "Enter") {
      event.preventDefault()
      choose(clampedHighlight)
    }
  }

  return (
    <div
      data-testid="command-palette-backdrop"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
    >
      <button
        type="button"
        aria-label="Close command palette"
        data-feature-help="Close the command palette without running an action"
        tabIndex={-1}
        onClick={onClose}
        className="-z-10 absolute inset-0 cursor-default bg-black/40"
      />
      <div
        data-testid="command-palette"
        className="flex max-h-[60vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <input
          ref={inputRef}
          data-testid="command-palette-input"
          aria-label="Search commands and projects"
          data-feature-help="Search commands and open projects; press Enter to run the highlighted action"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search commands and projects…"
          className="shrink-0 border-border border-b bg-transparent px-4 py-3 text-foreground text-sm outline-none placeholder:text-muted-foreground"
        />
        <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
          {ranked.length === 0 ? (
            <li
              data-testid="command-palette-empty"
              className="px-4 py-2 text-muted-foreground/70 text-xs"
            >
              No matching commands
            </li>
          ) : (
            ranked.map((entry, index) => {
              const { command, positions } = entry
              const Icon = command.icon
              const selected = index === clampedHighlight
              return (
                <li key={command.id}>
                  <button
                    type="button"
                    data-testid="command-palette-item"
                    data-command-id={command.id}
                    data-feature-label={command.label}
                    data-feature-help="Run this command or open the selected project"
                    data-index={index}
                    data-highlighted={selected}
                    onClick={() => choose(index)}
                    onMouseEnter={() => setHighlight(index)}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-4 py-1.5 text-left text-xs",
                      selected
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/60",
                    )}
                  >
                    <Icon className="size-3.5 shrink-0 opacity-70" />
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {highlightSegments(command.label, positions).map((segment, i) => (
                        <span
                          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and stable for a given render
                          key={i}
                          className={segment.matched ? "font-semibold text-foreground" : undefined}
                        >
                          {segment.text}
                        </span>
                      ))}
                    </span>
                    {command.hint ? (
                      <span className="shrink-0 truncate text-muted-foreground/60">
                        {command.hint}
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })
          )}
        </ul>
      </div>
    </div>
  )
}
