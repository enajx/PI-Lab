import { FitAddon } from "@xterm/addon-fit"
import { type ITheme, Terminal as XTerm } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { type CSSProperties, useEffect, useRef } from "react"
import { createPiLabTrpcClient, type PiLabTrpcClient } from "../trpc/client"
import { mapTerminalKeyEvent, type TerminalInputKind } from "./terminalKeyMapping"

/**
 * Live terminal pane (md/engineering/architecture.md (renderer)) wired end-to-end to the `terminal` tRPC
 * router (md/engineering/architecture.md (process model), md/engineering/architecture.md (agent runtime)). It streams a PTY session's bytes into xterm.js,
 * forwards keystrokes back, and keeps the PTY sized to the viewport.
 *
 * Two modes, picked by props:
 *   - **spawn mode** (default — no `sessionId`): on mount it spawns a fresh PTY
 *     session (the user's login shell, or the test-seam program) and subscribes
 *     to it. This is the index/test seam.
 *   - **attach mode** (`sessionId` given): it attaches to an *existing* session
 *     started elsewhere (e.g. `sessions.start` launching an agent) and only
 *     subscribes — it never spawns. The subscription replays scrollback as a
 *     leading chunk, so an attaching pane sees prior output. This is how the
 *     session/workspace view renders a running agent.
 *
 * Lifecycle ownership is deliberate: on unmount we unsubscribe and **detach**
 * (the subscription's teardown calls the daemon's `detach`) — we never `kill`.
 * The session lives in the separate pty-daemon process so it survives an Electron
 * reload (md/engineering/architecture.md (process model)); killing here would defeat that survival contract.
 *
 * Scrolling is xterm's own viewport, not Radix `ScrollArea` (AGENTS.md Pitfalls #3).
 */

interface TerminalProps {
  /** Whether this PTY hosts an interactive agent/TUI or an ordinary shell. */
  inputKind: TerminalInputKind
  /**
   * Injectable tRPC client for tests (md/engineering/testing-and-build.md); defaults to the real IPC
   * client. A fresh client per pane keeps subscriptions independent.
   */
  client?: PiLabTrpcClient
  /**
   * Attach to an existing PTY session instead of spawning. When set, all spawn
   * options below are ignored: the pane only subscribes (and the subscription
   * replays scrollback).
   */
  sessionId?: string
  /**
   * Working directory for the spawned PTY (spawn mode only). Defaults (in main)
   * to the user's home when omitted.
   */
  cwd?: string
  /**
   * Override the spawned program (spawn mode only). With no command the daemon
   * starts the user's login shell; tests pass a deterministic program.
   */
  command?: string
  /** Extra argv for {@link command} (spawn mode only). */
  args?: string[]
}

export function Terminal({ client, inputKind, sessionId, cwd, command, args }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Effect deps are intentionally empty: a terminal pane binds to one session for
  // its lifetime. Options are captured in a ref so changing a prop never
  // re-spawns/re-attaches (and never tears down a live agent session) mid-flight.
  const optionsRef = useRef({ client, inputKind, sessionId, cwd, command, args })
  optionsRef.current = { client, inputKind, sessionId, cwd, command, args }

  // Track the app's resolved mode and CSS-token palette so the terminal follows
  // Appearance changes without re-attaching the session.
  const xtermRef = useRef<XTerm | null>(null)
  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => {
      if (xtermRef.current) xtermRef.current.options.theme = currentTerminalTheme()
    })
    observer.observe(root, { attributes: true, attributeFilter: ["class", "style"] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const {
      client: injected,
      inputKind,
      sessionId: attachId,
      cwd,
      command,
      args,
    } = optionsRef.current
    const trpc = injected ?? createPiLabTrpcClient()

    const xterm = new XTerm({
      convertEol: true,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: currentTerminalTheme(),
    })
    xtermRef.current = xterm
    const fitAddon = new FitAddon()
    xterm.loadAddon(fitAddon)
    xterm.open(container)

    // `cancelled` guards every async hop so a fast unmount (e.g. React 19
    // StrictMode's mount/unmount/remount) cleans up correctly and never writes
    // into a disposed terminal.
    let cancelled = false
    let sessionId: string | null = null
    let unsubscribe: (() => void) | null = null
    let inputDisposable: { dispose: () => void } | null = null
    let resizeObserver: ResizeObserver | null = null

    /** Forward one input chunk exactly once, whether xterm generated or custom-mapped. */
    const forwardInput = (data: string): void => {
      if (cancelled || !sessionId) return
      void trpc.terminal.write.mutate({ sessionId, data }).catch(() => {})
    }

    // xterm cannot choose the right Shift+Enter protocol without knowing
    // whether this PTY is a shell or an agent TUI. Returning false suppresses
    // xterm's own onData for mapped keys, avoiding a second write.
    xterm.attachCustomKeyEventHandler((event) => {
      const data = mapTerminalKeyEvent(event, {
        platform: isMacOSPlatform(navigator.platform) ? "darwin" : "other",
        inputKind,
      })
      if (data === null) return true
      event.preventDefault()
      forwardInput(data)
      return false
    })

    /** Fit to the container, then push the new grid size to the PTY. */
    const syncSize = () => {
      if (cancelled || !sessionId) return
      try {
        fitAddon.fit()
      } catch {
        // The container can be momentarily zero-sized during layout; ignore and
        // let the next ResizeObserver tick re-fit.
        return
      }
      void trpc.terminal.resize
        .mutate({ sessionId, cols: xterm.cols, rows: xterm.rows })
        .catch(() => {})
    }

    /** Wire the streaming subscription + stdin forwarding for a session id. */
    const bind = (id: string) => {
      sessionId = id

      // Stream daemon output into xterm. `onData` yields our `TerminalEvent`
      // discriminated union: incremental `data` chunks (including replayed
      // scrollback as a single leading chunk) then a terminal `exit`.
      const subscription = trpc.terminal.onData.subscribe(
        { sessionId: id },
        {
          onData: (event) => {
            if (cancelled) return
            if (event.type === "data") xterm.write(event.chunk)
            else xterm.write(`\r\n[pi-lab] session exited (code ${event.exitCode ?? "?"})\r\n`)
          },
          onError: (error) => {
            if (cancelled) return
            xterm.write(`\r\n[pi-lab] terminal connection failed: ${error.message}\r\n`)
          },
        },
      )
      unsubscribe = () => subscription.unsubscribe()

      // Forward keystrokes (and pasted text) to the PTY's stdin.
      inputDisposable = xterm.onData(forwardInput)

      // Keep the PTY grid matched to the viewport.
      resizeObserver = new ResizeObserver(() => syncSize())
      resizeObserver.observe(container)
      syncSize()
      xterm.focus()
    }

    void (async () => {
      // Size the initial grid to the real container before binding so the PTY
      // starts (spawn) / resizes (attach) at the right dimensions.
      try {
        fitAddon.fit()
      } catch {
        // Fall back to xterm's default cols/rows if the container isn't laid out.
      }

      // Attach mode: bind to the session started elsewhere; never spawn.
      if (attachId) {
        if (cancelled) return
        bind(attachId)
        return
      }

      // Spawn mode: create a fresh PTY, then bind to it.
      let spawned: { sessionId: string }
      try {
        spawned = await trpc.terminal.spawn.mutate({
          cwd,
          command,
          args,
          cols: xterm.cols,
          rows: xterm.rows,
        })
      } catch (error) {
        if (!cancelled) {
          xterm.write(`\r\n[pi-lab] failed to start terminal: ${String(error)}\r\n`)
        }
        return
      }
      if (cancelled) return
      bind(spawned.sessionId)
    })()

    return () => {
      cancelled = true
      resizeObserver?.disconnect()
      inputDisposable?.dispose()
      // Unsubscribe first: the subscription's server-side teardown `detach`es the
      // session (it is NOT killed), so the PTY persists across reload (md/engineering/architecture.md (process model)).
      unsubscribe?.()
      xterm.dispose()
      xtermRef.current = null
    }
  }, [])

  return (
    <div
      ref={containerRef}
      data-testid="terminal"
      data-input-kind={inputKind}
      data-session-id={sessionId}
      style={{ ...paneStyle, background: "var(--background)" }}
    />
  )
}

function isMacOSPlatform(platform: string): boolean {
  return /^Mac/u.test(platform)
}

/** Whether the app is currently in dark mode (the `<html>` `.dark` class). */
function currentIsDark(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark")
}

const DARK_TERMINAL_THEME: ITheme = {
  background: "#101014",
  foreground: "#e6e6ea",
  cursor: "#e6e6ea",
}

/** A clean light terminal palette (GitHub-light-ish) for the app's light theme. */
const LIGHT_TERMINAL_THEME: ITheme = {
  background: "#ffffff",
  foreground: "#1f2328",
  cursor: "#1f2328",
  cursorAccent: "#ffffff",
  selectionBackground: "#bcdcff",
  black: "#1f2328",
  red: "#cf222e",
  green: "#116329",
  yellow: "#7d4e00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
}

function terminalTheme(isDark: boolean): ITheme {
  return isDark ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME
}

function currentTerminalTheme(): ITheme {
  const fallback = terminalTheme(currentIsDark())
  if (typeof document === "undefined") return fallback
  const styles = window.getComputedStyle(document.documentElement)
  const background = styles.getPropertyValue("--background").trim()
  const foreground = styles.getPropertyValue("--foreground").trim()
  const selectionBackground = styles.getPropertyValue("--accent").trim()
  return {
    ...fallback,
    ...(background ? { background } : {}),
    ...(foreground ? { foreground, cursor: foreground } : {}),
    ...(selectionBackground ? { selectionBackground } : {}),
  }
}

// xterm manages its own scrollback viewport; the pane just needs to be a bounded
// box that fills its parent (AGENTS.md Pitfalls #3 — no Radix ScrollArea).
const paneStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  minHeight: 0,
  overflow: "hidden",
}
