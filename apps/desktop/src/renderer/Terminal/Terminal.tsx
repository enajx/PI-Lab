import { FitAddon } from "@xterm/addon-fit"
import { Terminal as XTerm } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { type CSSProperties, useEffect, useRef } from "react"
import { createSkipperTrpcClient, type SkipperTrpcClient } from "../trpc/client"

/**
 * Live terminal pane (AGENTS.md §7) wired end-to-end to the `terminal` tRPC
 * router (AGENTS.md §6, §8). It streams a PTY session's bytes into xterm.js,
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
 * reload (AGENTS.md §6); killing here would defeat that survival contract.
 *
 * Scrolling is xterm's own viewport, not Radix `ScrollArea` (AGENTS.md §12.3).
 */

interface TerminalProps {
  /**
   * Injectable tRPC client for tests (AGENTS.md §14); defaults to the real IPC
   * client. A fresh client per pane keeps subscriptions independent.
   */
  client?: SkipperTrpcClient
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

export function Terminal({ client, sessionId, cwd, command, args }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Effect deps are intentionally empty: a terminal pane binds to one session for
  // its lifetime. Options are captured in a ref so changing a prop never
  // re-spawns/re-attaches (and never tears down a live agent session) mid-flight.
  const optionsRef = useRef({ client, sessionId, cwd, command, args })
  optionsRef.current = { client, sessionId, cwd, command, args }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const { client: injected, sessionId: attachId, cwd, command, args } = optionsRef.current
    const trpc = injected ?? createSkipperTrpcClient()

    const xterm = new XTerm({
      convertEol: true,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: { background: "#101014", foreground: "#e6e6ea" },
    })
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
            else xterm.write(`\r\n[skipper] session exited (code ${event.exitCode ?? "?"})\r\n`)
          },
        },
      )
      unsubscribe = () => subscription.unsubscribe()

      // Forward keystrokes (and pasted text) to the PTY's stdin.
      inputDisposable = xterm.onData((data) => {
        if (cancelled || !sessionId) return
        void trpc.terminal.write.mutate({ sessionId, data }).catch(() => {})
      })

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
          xterm.write(`\r\n[skipper] failed to start terminal: ${String(error)}\r\n`)
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
      // session (it is NOT killed), so the PTY persists across reload (§6).
      unsubscribe?.()
      xterm.dispose()
    }
  }, [])

  return <div ref={containerRef} data-testid="terminal" style={paneStyle} />
}

// xterm manages its own scrollback viewport; the pane just needs to be a bounded
// box that fills its parent (AGENTS.md §12.3 — no Radix ScrollArea).
const paneStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  minHeight: 0,
  background: "#101014",
  overflow: "hidden",
}
