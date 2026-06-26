import { type Diagnostic, linter, lintGutter } from "@codemirror/lint"
import { Compartment, EditorState } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { vim } from "@replit/codemirror-vim"
import { basicSetup } from "codemirror"
import { useEffect, useRef } from "react"
import { languageForPath } from "../../utils/languageForPath"
import { editorThemeExtension } from "../editorThemes"

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
  /**
   * Optional diagnostics source (Python `ty`/`ruff` in the integrate stage).
   * Omitted in the editor core ⇒ no linting is attached. Re-supplying a new
   * function re-runs the linter.
   */
  diagnostics?: DiagnosticsSource
}

/**
 * Thin React wrapper around a CodeMirror 6 `EditorView` (docs/architecture.md (renderer); spec:
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
  vim: vimEnabled = false,
  theme,
  diagnostics,
}: CodeMirrorBufferProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)

  // Latest callbacks captured in refs so the one-time mount effect always calls
  // through to the current handlers without re-creating the view on each render.
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  onChangeRef.current = onChange
  onSaveRef.current = onSave

  // Reconfigurable slices of the config. Created once per mount.
  const languageCompartment = useRef(new Compartment()).current
  const vimCompartment = useRef(new Compartment()).current
  const themeCompartment = useRef(new Compartment()).current
  const lintCompartment = useRef(new Compartment()).current

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
    ])

    const changeListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) onChangeRef.current(update.state.doc.toString())
    })

    const state = EditorState.create({
      doc: initialDoc,
      extensions: [
        // Vim must precede other keymaps to win precedence when enabled.
        vimCompartment.of(vimEnabled ? vim() : []),
        basicSetup,
        languageCompartment.of(languageForPath(relPath) ?? []),
        // Color theme (chrome + syntax highlighting) chosen in Settings → Editor.
        // Layered over basicSetup's default highlight; the structural height theme
        // below only sets layout, so the two never conflict on color.
        themeCompartment.of(editorThemeExtension(theme)),
        lintCompartment.of(lintExtension(diagnostics)),
        saveKeymap,
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
      effects: themeCompartment.reconfigure(editorThemeExtension(theme)),
    })
  }, [theme, themeCompartment])

  // Swap the diagnostics source live.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: lintCompartment.reconfigure(lintExtension(diagnostics)),
    })
  }, [diagnostics, lintCompartment])

  return (
    <div ref={hostRef} data-testid="editor-buffer" className="min-h-0 flex-1 overflow-hidden" />
  )
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
