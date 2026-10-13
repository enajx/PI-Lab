import { type Diagnostic, linter, lintGutter } from "@codemirror/lint"
import { Compartment, EditorState, Prec } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import type { ImportedEditorTheme } from "@pi-lab/local-db/editor-settings"
import { vim } from "@replit/codemirror-vim"
import { basicSetup } from "codemirror"
import { type CSSProperties, useEffect, useRef, useState } from "react"
import { useTranslate } from "../../../i18n/language"
import {
  editorFontFamilyCss,
  useEditorFontFamily,
  useEditorFontSize,
} from "../../../preferences/preferences"
import { languageForPath } from "../../utils/languageForPath"
import { editorThemeExtension } from "../editorThemes"
import {
  MARKDOWN_BLOCK_COMMANDS,
  type MarkdownMode,
  type MarkdownProjectEntry,
  type MarkdownSlashCommand,
  markdownRenderExtension,
} from "./markdownEditing"

/**
 * Source of diagnostics for one buffer. Given the current document text it
 * returns the diagnostics to render as squiggles + gutter markers. The integrate
 * stage supplies the real Python (`ty`/`ruff`) source; the editor core only
 * knows how to *display* whatever it returns, so this prop keeps diagnostics
 * fully decoupled from the one-shot CLI wiring (TODO "Built-in editor").
 */
export type DiagnosticsSource = (doc: string) => Diagnostic[] | Promise<Diagnostic[]>

interface CodeMirrorBufferProps {
  /**
   * The buffer's path relative to the workspace working dir. Drives language
   * highlighting (Python in v1) and is the identity used by the parent to keep
   * one CodeMirror view per open file.
   */
  relPath: string
  /**
   * Initial document text. Changing it remounts the view via the parent's
   * `key`, so this is read once per mount; live external reloads are applied by
   * the parent through {@link onChange}/remount, not by mutating this prop.
   */
  initialDoc: string
  /** Fires on every user edit with the full document text (drives the dirty dot). */
  onChange: (doc: string) => void
  /**
   * Fires when the user presses ⌘S. The parent performs the actual `files.write`
   * and, on success, calls back into {@link onSaved}. Returning is irrelevant —
   * the keybinding always swallows the event so the browser's Save never fires.
   */
  onSave: () => void
  /** Fires on Mod+Enter while this focused buffer is eligible to run. */
  onRun?: () => void
  /**
   * Optional Vim keymap toggle (TODO "Built-in editor" — off by default). Wired
   * here behind the prop so the integrate stage can surface it as a setting
   * without touching this component.
   */
  vim?: boolean
  /**
   * Optional color-theme id (the stored `EditorSettings.editorTheme`). Resolved to
   * a CodeMirror extension via {@link editorThemeExtension} and layered on top of
   * the structural height/scroll theme. Omitted / `"default"` / unknown ⇒ the
   * registry's default theme. Changing it reconfigures live (no remount).
   */
  theme?: string
  /** Parsed custom themes copied into editor settings. */
  customThemes?: ImportedEditorTheme[]
  /**
   * Optional diagnostics source (Python `ty`/`ruff` in the integrate stage).
   * Omitted in the editor core ⇒ no linting is attached. Re-supplying a new
   * function re-runs the linter.
   */
  diagnostics?: DiagnosticsSource
  /** Markdown-only source presentation. Render is WYSIWYM; Source is unstyled raw text. */
  markdownMode?: MarkdownMode
  /** Optional local file choices for isolated editor use and tests. */
  projectEntries?: MarkdownProjectEntry[]
  /** Search the current workspace for files matching a Markdown `@` query. */
  searchProjectFiles?: (query: string) => Promise<MarkdownProjectEntry[]>
}

interface MarkdownToolbarState {
  from: number
  to: number
  top: number
  left: number
}

interface MarkdownSlashState {
  from: number
  to: number
  query: string
  top: number
  left: number
}

interface MarkdownMentionState {
  from: number
  to: number
  query: string
  top: number
  left: number
}

interface MarkdownOverlayState {
  toolbar: MarkdownToolbarState | null
  slash: MarkdownSlashState | null
  mention: MarkdownMentionState | null
}

const EMPTY_MARKDOWN_OVERLAY: MarkdownOverlayState = { toolbar: null, slash: null, mention: null }

/**
 * Thin React wrapper around a CodeMirror 6 `EditorView` (md/engineering/architecture.md (renderer); spec:
 * TODO "Built-in editor"). It owns exactly one view for its lifetime: the doc,
 * language, ⌘S keybinding, and change listener are wired once on mount, and
 * mutable concerns (the language for the current path, vim, the diagnostics
 * source) live in CodeMirror `Compartment`s so they can be reconfigured without
 * tearing the view down and losing cursor/scroll/undo state.
 *
 * The parent (`Editor`) keeps one buffer per open file and swaps the *active*
 * one by `relPath`; remounting on a real document identity change is handled
 * there via React `key`, so this component never has to diff `initialDoc`.
 *
 * Uses `codemirror`'s `basicSetup` per the spec
 * (https://codemirror.net/docs/ref/#basic-setup): line numbers, history,
 * bracket matching, multi-cursor, and the standard keymap come for free.
 */
export function CodeMirrorBuffer({
  relPath,
  initialDoc,
  onChange,
  onSave,
  onRun,
  vim: vimEnabled = false,
  theme,
  customThemes,
  diagnostics,
  markdownMode,
  projectEntries,
  searchProjectFiles,
}: CodeMirrorBufferProps) {
  const t = useTranslate()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [fontFamily] = useEditorFontFamily()
  const [fontSize] = useEditorFontSize()
  const markdown = isMarkdownPath(relPath)
  const activeMarkdownMode: MarkdownMode = markdownMode ?? "source"
  const [markdownOverlay, setMarkdownOverlay] =
    useState<MarkdownOverlayState>(EMPTY_MARKDOWN_OVERLAY)
  const [activeSlashIndex, setActiveSlashIndex] = useState(0)
  const [slashGroup, setSlashGroup] = useState<MarkdownSlashCommand | null>(null)
  const [activeMentionIndex, setActiveMentionIndex] = useState(0)
  const [mentionEntries, setMentionEntries] = useState<MarkdownProjectEntry[]>([])
  const [mentionLoading, setMentionLoading] = useState(false)
  const [mentionError, setMentionError] = useState<string | null>(null)
  const slashCommands = MARKDOWN_BLOCK_COMMANDS
  const matchingSlashCommands = markdownOverlay.slash
    ? (slashGroup?.children ?? slashCommands).filter((command) =>
        slashGroup
          ? true
          : [command.label, t(command.label)].some((label) =>
              label
                .toLocaleLowerCase()
                .includes(markdownOverlay.slash?.query.toLocaleLowerCase() ?? ""),
            ),
      )
    : []
  const selectedSlashIndex = Math.min(activeSlashIndex, matchingSlashCommands.length - 1)
  const selectedMentionIndex = Math.min(activeMentionIndex, mentionEntries.length - 1)
  const markdownOverlayRef = useRef(markdownOverlay)
  const matchingSlashCommandsRef = useRef(matchingSlashCommands)
  const selectedSlashIndexRef = useRef(selectedSlashIndex)
  const mentionEntriesRef = useRef(mentionEntries)
  const selectedMentionIndexRef = useRef(selectedMentionIndex)
  const searchProjectFilesRef = useRef(searchProjectFiles)
  const projectEntriesRef = useRef(projectEntries)
  markdownOverlayRef.current = markdownOverlay
  matchingSlashCommandsRef.current = matchingSlashCommands
  selectedSlashIndexRef.current = selectedSlashIndex
  mentionEntriesRef.current = mentionEntries
  selectedMentionIndexRef.current = selectedMentionIndex
  searchProjectFilesRef.current = searchProjectFiles
  projectEntriesRef.current = projectEntries

  useEffect(() => {
    if (selectedSlashIndex < 0) return
    document
      .getElementById(`markdown-slash-option-${selectedSlashIndex}`)
      ?.scrollIntoView({ block: "nearest" })
  }, [selectedSlashIndex])

  useEffect(() => {
    if (selectedMentionIndex < 0) return
    document
      .getElementById(`markdown-mention-option-${selectedMentionIndex}`)
      ?.scrollIntoView({ block: "nearest" })
  }, [selectedMentionIndex])

  const mentionQuery = markdownOverlay.mention?.query ?? null
  useEffect(() => {
    setMentionEntries([])
    setMentionError(null)
    setMentionLoading(false)
    if (!mentionQuery?.trim()) return

    let cancelled = false
    const timer = window.setTimeout(() => {
      const search = searchProjectFilesRef.current
      if (!search) {
        const query = mentionQuery.toLowerCase()
        setMentionEntries(
          (projectEntriesRef.current ?? []).filter(
            (entry) => entry.kind === "file" && entry.relPath.toLowerCase().includes(query),
          ),
        )
        return
      }
      setMentionLoading(true)
      void search(mentionQuery)
        .then((entries) => {
          if (!cancelled) setMentionEntries(entries.filter((entry) => entry.kind === "file"))
        })
        .catch((error: unknown) => {
          if (!cancelled) setMentionError(String(error))
        })
        .finally(() => {
          if (!cancelled) setMentionLoading(false)
        })
    }, 120)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [mentionQuery])

  // Latest callbacks captured in refs so the one-time mount effect always calls
  // through to the current handlers without re-creating the view on each render.
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const onRunRef = useRef(onRun)
  onChangeRef.current = onChange
  onSaveRef.current = onSave
  onRunRef.current = onRun

  // Reconfigurable slices of the config. Created once per mount.
  const languageCompartment = useRef(new Compartment()).current
  const vimCompartment = useRef(new Compartment()).current
  const themeCompartment = useRef(new Compartment()).current
  const lintCompartment = useRef(new Compartment()).current
  const markdownCompartment = useRef(new Compartment()).current

  // Build the view exactly once. Deps are intentionally empty: live changes flow
  // through the compartments / callback refs below, never a remount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one view per mount; reconfig via compartments
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const saveKeymap = keymap.of([
      {
        key: "Mod-s",
        // Always returns true so CodeMirror swallows ⌘S (no browser Save dialog).
        run: () => {
          onSaveRef.current()
          return true
        },
      },
      {
        key: "Mod-Enter",
        run: () => {
          if (!onRunRef.current) return false
          onRunRef.current()
          return true
        },
      },
    ])

    const updateMarkdownOverlay = (view: EditorView) => {
      const next = readMarkdownOverlay(view, host)
      const previous = markdownOverlayRef.current.slash
      if (previous?.from !== next.slash?.from || previous?.query !== next.slash?.query) {
        setActiveSlashIndex(0)
        setSlashGroup(null)
      }
      const previousMention = markdownOverlayRef.current.mention
      if (
        previousMention?.from !== next.mention?.from ||
        previousMention?.query !== next.mention?.query
      ) {
        setActiveMentionIndex(0)
      }
      markdownOverlayRef.current = next
      setMarkdownOverlay(next)
    }

    const changeListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) onChangeRef.current(update.state.doc.toString())
      if (
        markdown &&
        (update.docChanged ||
          update.selectionSet ||
          update.geometryChanged ||
          update.viewportChanged)
      ) {
        updateMarkdownOverlay(update.view)
      }
    })

    const markdownMenuKeys = Prec.highest(
      keymap.of([
        {
          key: "ArrowDown",
          run: () => {
            const mention = markdownOverlayRef.current.mention
            const entries = mentionEntriesRef.current
            if (markdown && mention && entries.length > 0) {
              setActiveMentionIndex((current) => (current + 1) % entries.length)
              return true
            }
            const trigger = markdownOverlayRef.current.slash
            const commands = matchingSlashCommandsRef.current
            if (!markdown || !trigger || commands.length === 0) return false
            setActiveSlashIndex((current) => (current + 1) % commands.length)
            return true
          },
        },
        {
          key: "ArrowUp",
          run: () => {
            const mention = markdownOverlayRef.current.mention
            const entries = mentionEntriesRef.current
            if (markdown && mention && entries.length > 0) {
              setActiveMentionIndex((current) => (current - 1 + entries.length) % entries.length)
              return true
            }
            const trigger = markdownOverlayRef.current.slash
            const commands = matchingSlashCommandsRef.current
            if (!markdown || !trigger || commands.length === 0) return false
            setActiveSlashIndex((current) => (current - 1 + commands.length) % commands.length)
            return true
          },
        },
        {
          key: "Enter",
          run: (view) => {
            const mention = markdownOverlayRef.current.mention
            const entries = mentionEntriesRef.current
            if (markdown && mention && entries.length > 0) {
              const entry = entries[selectedMentionIndexRef.current]
              if (!entry) return false
              applyProjectLink(view, mention, entry, relPath)
              return true
            }
            const trigger = markdownOverlayRef.current.slash
            const commands = matchingSlashCommandsRef.current
            if (markdown && trigger && commands.length > 0) {
              const command = commands[selectedSlashIndexRef.current]
              if (!command) return false
              if (command.children) {
                setSlashGroup(command)
                setActiveSlashIndex(0)
                return true
              }
              applySlashCommand(view, trigger, command)
              return true
            }
            return markdown ? continueMarkdownList(view) : false
          },
        },
        {
          key: "Escape",
          run: () => {
            if (!markdownOverlayRef.current.slash && !markdownOverlayRef.current.mention)
              return false
            if (slashGroup) {
              setSlashGroup(null)
              setActiveSlashIndex(0)
              return true
            }
            markdownOverlayRef.current = EMPTY_MARKDOWN_OVERLAY
            setMarkdownOverlay(EMPTY_MARKDOWN_OVERLAY)
            return true
          },
        },
      ]),
    )

    const state = EditorState.create({
      doc: initialDoc,
      extensions: [
        // Vim must precede other keymaps to win precedence when enabled.
        vimCompartment.of(vimEnabled ? vim() : []),
        // Run/save must precede basicSetup's Enter keymap so Mod+Enter does not
        // fall through and insert a newline.
        saveKeymap,
        basicSetup,
        languageCompartment.of(languageForPath(relPath) ?? []),
        // Color theme (chrome + syntax highlighting) chosen in Settings → Editor.
        // Layered over basicSetup's default highlight; the structural height theme
        // below only sets layout, so the two never conflict on color.
        themeCompartment.of(editorThemeExtension(theme, customThemes)),
        editorTypographyExtension,
        lintCompartment.of(lintExtension(diagnostics)),
        markdownCompartment.of(
          markdown && activeMarkdownMode === "render" ? markdownRenderExtension : [],
        ),
        markdownMenuKeys,
        changeListener,
        EditorView.lineWrapping,
        // Constrain the view to its bounded host so it scrolls internally instead of
        // growing past the (overflow-hidden) container and being clipped — the
        // canonical CodeMirror fixed-height setup (AGENTS.md Pitfalls #3, native scroll).
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": { overflow: "auto" },
        }),
      ],
    })

    const view = new EditorView({ state, parent: host })
    viewRef.current = view
    view.focus()
    if (markdown) updateMarkdownOverlay(view)

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

  // Re-pick the language when the path changes (e.g. the parent reuses this
  // buffer instance for a different file — currently it remounts via key, but
  // keep this resilient and cheap).
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: languageCompartment.reconfigure(languageForPath(relPath) ?? []),
    })
  }, [relPath, languageCompartment])

  // Toggle the vim keymap live.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: vimCompartment.reconfigure(vimEnabled ? vim() : []),
    })
  }, [vimEnabled, vimCompartment])

  // Swap the color theme live.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.reconfigure(editorThemeExtension(theme, customThemes)),
    })
  }, [theme, customThemes, themeCompartment])

  // Swap the diagnostics source live.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: lintCompartment.reconfigure(lintExtension(diagnostics)),
    })
  }, [diagnostics, lintCompartment])

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: markdownCompartment.reconfigure(
        markdown && activeMarkdownMode === "render" ? markdownRenderExtension : [],
      ),
    })
  }, [activeMarkdownMode, markdown, markdownCompartment])

  const formatSelection = (prefix: string, suffix: string, placeholder: string) => {
    const view = viewRef.current
    const range = markdownOverlay.toolbar
    if (!view || !range) return
    const selected = view.state.sliceDoc(range.from, range.to) || placeholder
    const replacement = `${prefix}${selected}${suffix}`
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: replacement },
      selection: {
        anchor: range.from + prefix.length,
        head: range.from + prefix.length + selected.length,
      },
    })
    view.focus()
  }

  const insertSlashCommand = (command: MarkdownSlashCommand) => {
    const view = viewRef.current
    const trigger = markdownOverlay.slash
    if (!view || !trigger) return
    if (command.children) {
      setSlashGroup(command)
      setActiveSlashIndex(0)
      return
    }
    applySlashCommand(view, trigger, command)
    view.focus()
  }

  const insertProjectLink = (entry: MarkdownProjectEntry) => {
    const view = viewRef.current
    const mention = markdownOverlay.mention
    if (!view || !mention) return
    applyProjectLink(view, mention, entry, relPath)
    view.focus()
  }

  return (
    <div data-testid="editor-buffer" className="relative min-h-0 flex-1 overflow-hidden">
      <div
        ref={hostRef}
        className="h-full min-h-0 overflow-hidden"
        style={editorTypographyStyle(fontFamily, fontSize)}
      />
      {markdownOverlay.toolbar ? (
        <div
          role="toolbar"
          aria-label={t("Markdown formatting")}
          data-testid="markdown-selection-toolbar"
          className="absolute z-30 flex items-center gap-0.5 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
          style={{
            top: markdownOverlay.toolbar.top,
            left: markdownOverlay.toolbar.left,
          }}
          onMouseDown={(event) => event.preventDefault()}
        >
          <MarkdownFormatButton
            label={t("Bold")}
            text="B"
            className="font-bold"
            onClick={() => formatSelection("**", "**", "bold text")}
          />
          <MarkdownFormatButton
            label={t("Italic")}
            text="I"
            className="italic"
            onClick={() => formatSelection("_", "_", "italic text")}
          />
          <MarkdownFormatButton
            label={t("Strikethrough")}
            text="S"
            className="line-through"
            onClick={() => formatSelection("~~", "~~", "struck text")}
          />
          <MarkdownFormatButton
            label={t("Inline code")}
            text="&lt;/&gt;"
            className="font-mono text-[10px]"
            onClick={() => formatSelection("`", "`", "code")}
          />
          <MarkdownFormatButton
            label={t("Link")}
            text="↗"
            onClick={() => formatSelection("[", "](url)", "link text")}
          />
        </div>
      ) : null}
      {markdownOverlay.slash ? (
        <div
          role="listbox"
          aria-label={t("Markdown blocks")}
          aria-activedescendant={
            selectedSlashIndex >= 0 ? `markdown-slash-option-${selectedSlashIndex}` : undefined
          }
          tabIndex={-1}
          data-testid="markdown-slash-menu"
          className="absolute z-30 max-h-56 w-64 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl"
          style={{ top: markdownOverlay.slash.top, left: markdownOverlay.slash.left }}
        >
          {matchingSlashCommands.length > 0 ? (
            matchingSlashCommands.map((command, index) => (
              <button
                key={command.id}
                id={`markdown-slash-option-${index}`}
                type="button"
                role="option"
                aria-selected={index === selectedSlashIndex}
                aria-label={t(command.label)}
                className={`flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left hover:bg-accent ${
                  index === selectedSlashIndex ? "bg-accent" : ""
                }`}
                onMouseDown={(event) => {
                  event.preventDefault()
                  insertSlashCommand(command)
                }}
              >
                <span className="text-xs">{t(command.label)}</span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {t(command.hint)}
                </span>
              </button>
            ))
          ) : (
            <p className="px-2 py-2 text-muted-foreground text-xs">
              {t("No Markdown block matches.")}
            </p>
          )}
        </div>
      ) : null}
      {markdownOverlay.mention ? (
        <div
          role="listbox"
          aria-label="Project files"
          aria-activedescendant={
            selectedMentionIndex >= 0
              ? `markdown-mention-option-${selectedMentionIndex}`
              : undefined
          }
          tabIndex={-1}
          data-testid="markdown-mention-menu"
          className="absolute z-30 max-h-56 w-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl"
          style={{ top: markdownOverlay.mention.top, left: markdownOverlay.mention.left }}
        >
          {!markdownOverlay.mention.query.trim() ? (
            <p className="px-2 py-2 text-muted-foreground text-xs">Type to find a project file.</p>
          ) : mentionLoading ? (
            <p className="px-2 py-2 text-muted-foreground text-xs">Searching project files…</p>
          ) : mentionError ? (
            <p className="px-2 py-2 text-destructive text-xs">File search failed: {mentionError}</p>
          ) : mentionEntries.length > 0 ? (
            mentionEntries.map((entry, index) => (
              <button
                key={entry.relPath}
                id={`markdown-mention-option-${index}`}
                type="button"
                role="option"
                aria-selected={index === selectedMentionIndex}
                aria-label={entry.relPath}
                className={`flex w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent ${
                  index === selectedMentionIndex ? "bg-accent" : ""
                }`}
                onMouseDown={(event) => {
                  event.preventDefault()
                  insertProjectLink(entry)
                }}
              >
                <span className="truncate">{entry.relPath}</span>
              </button>
            ))
          ) : (
            <p className="px-2 py-2 text-muted-foreground text-xs">No project files match.</p>
          )}
        </div>
      ) : null}
    </div>
  )
}

const editorTypographyExtension = EditorView.theme({
  "&": {
    fontFamily: "var(--pi-lab-editor-font-family)",
    fontSize: "var(--pi-lab-editor-font-size)",
  },
  ".cm-content": {
    fontFamily: "var(--pi-lab-editor-font-family)",
    fontSize: "var(--pi-lab-editor-font-size)",
  },
  ".cm-gutters": {
    fontFamily: "var(--pi-lab-editor-font-family)",
    fontSize: "var(--pi-lab-editor-font-size)",
  },
})

function editorTypographyStyle(fontFamily: string, fontSize: number): CSSProperties {
  return {
    "--pi-lab-editor-font-family": editorFontFamilyCss(fontFamily),
    "--pi-lab-editor-font-size": `${fontSize}px`,
  } as CSSProperties
}

function MarkdownFormatButton({
  label,
  text,
  className,
  onClick,
}: {
  label: string
  text: string
  className?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-xs hover:bg-accent ${className ?? ""}`}
      onClick={onClick}
    >
      {text}
    </button>
  )
}

function applySlashCommand(
  view: EditorView,
  trigger: MarkdownSlashState,
  command: MarkdownSlashCommand,
) {
  const cursor = trigger.from + (command.cursorOffset ?? command.insert.length)
  view.dispatch({
    changes: { from: trigger.from, to: trigger.to, insert: command.insert },
    selection: { anchor: cursor },
  })
}

/** Replace an @ query with a link relative to the current Markdown file. */
function applyProjectLink(
  view: EditorView,
  trigger: MarkdownMentionState,
  entry: MarkdownProjectEntry,
  sourcePath: string,
) {
  const sourceDirectory = sourcePath.split("/").slice(0, -1)
  const targetParts = entry.relPath.split("/")
  while (sourceDirectory.length > 0 && sourceDirectory[0] === targetParts[0]) {
    sourceDirectory.shift()
    targetParts.shift()
  }
  const destination = [...sourceDirectory.map(() => ".."), ...targetParts]
    .map((part) =>
      encodeURIComponent(part).replace(
        /[()]/g,
        (character) => `%${character.charCodeAt(0).toString(16)}`,
      ),
    )
    .join("/")
  const name = entry.name.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]")
  const insert = `[${name}](${destination})`
  view.dispatch({
    changes: { from: trigger.from, to: trigger.to, insert },
    selection: { anchor: trigger.from + insert.length },
  })
}

/** Continue ordinary, ordered, and task Markdown lists without changing other Enter behavior. */
function continueMarkdownList(view: EditorView): boolean {
  const selection = view.state.selection.main
  if (!selection.empty) return false
  const line = view.state.doc.lineAt(selection.head)
  if (selection.head !== line.to) return false

  const task = /^(\s*)([-+*])\s+\[([ xX])\]\s*(.*)$/.exec(line.text)
  const ordered = /^(\s*)(\d+)([.)])\s+(.*)$/.exec(line.text)
  const bullet = /^(\s*)([-+*])\s+(.*)$/.exec(line.text)
  const match = task ?? ordered ?? bullet
  if (!match) return false

  const content = match.at(-1) ?? ""
  if (!content.trim()) {
    const indent = match[1] ?? ""
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: indent },
      selection: { anchor: line.from + indent.length },
    })
    return true
  }
  const prefix = task
    ? `${task[1] ?? ""}${task[2] ?? "-"} [ ] `
    : ordered
      ? `${ordered[1] ?? ""}${Number(ordered[2] ?? "0") + 1}${ordered[3] ?? "."} `
      : `${bullet?.[1] ?? ""}${bullet?.[2] ?? "-"} `
  const insert = `\n${prefix}`
  view.dispatch({
    changes: { from: line.to, to: line.to, insert },
    selection: { anchor: line.to + insert.length },
  })
  return true
}

function isMarkdownPath(relPath: string): boolean {
  return /\.(?:md|markdown|mdx)$/i.test(relPath)
}

function readMarkdownOverlay(view: EditorView, host: HTMLElement): MarkdownOverlayState {
  const selection = view.state.selection.main
  if (!selection.empty) {
    const start = overlayPosition(view, selection.from, host, true)
    return {
      toolbar: { from: selection.from, to: selection.to, ...start },
      slash: null,
      mention: null,
    }
  }

  const line = view.state.doc.lineAt(selection.head)
  const beforeCursor = line.text.slice(0, selection.head - line.from)
  const mentionMatch = /(?:^|[\s(])@([^\s@]*)$/.exec(beforeCursor)
  if (mentionMatch) {
    const mentionIndex = beforeCursor.lastIndexOf("@")
    return {
      toolbar: null,
      slash: null,
      mention: {
        from: line.from + mentionIndex,
        to: selection.head,
        query: mentionMatch[1] ?? "",
        ...overlayPosition(view, selection.head, host, false),
      },
    }
  }
  const slashMatch = /(?:^|\s)\/([a-z0-9 -]*)$/i.exec(beforeCursor)
  if (!slashMatch) return EMPTY_MARKDOWN_OVERLAY
  const slashIndex = beforeCursor.lastIndexOf("/")
  const start = line.from + slashIndex
  const position = overlayPosition(view, selection.head, host, false)
  return {
    toolbar: null,
    slash: {
      from: start,
      to: selection.head,
      query: (slashMatch[1] ?? "").trim(),
      ...position,
    },
    mention: null,
  }
}

function overlayPosition(
  view: EditorView,
  position: number,
  host: HTMLElement,
  above: boolean,
): { top: number; left: number } {
  if (typeof Range === "undefined" || typeof Range.prototype.getClientRects !== "function") {
    return { top: above ? 8 : 32, left: 8 }
  }
  const coordinates = view.coordsAtPos(position)
  const bounds = host.getBoundingClientRect()
  if (!coordinates) return { top: above ? 8 : 32, left: 8 }
  const desiredTop = above ? coordinates.top - bounds.top - 38 : coordinates.bottom - bounds.top + 6
  return {
    top: Math.max(8, desiredTop),
    left: Math.max(8, Math.min(coordinates.left - bounds.left, Math.max(8, bounds.width - 288))),
  }
}

/**
 * Build the lint extension for a (maybe-absent) diagnostics source. CodeMirror's
 * `linter` callback hands us the live `EditorView`, so we read the current doc
 * text from it and pass that to the source — keeping the public
 * {@link DiagnosticsSource} signature simply `(doc) => diagnostics`. With no
 * source, linting is off entirely.
 */
function lintExtension(source: DiagnosticsSource | undefined) {
  if (!source) return []
  return [
    linter((view): Diagnostic[] | Promise<Diagnostic[]> => source(view.state.doc.toString())),
    lintGutter(),
  ]
}
