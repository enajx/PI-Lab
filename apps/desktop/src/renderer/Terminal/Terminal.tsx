import { FitAddon } from "@xterm/addon-fit"
import { type ITheme, Terminal as XTerm } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { type CSSProperties, useEffect, useRef, useState } from "react"
import { registerDictationTarget } from "../dictation/targets"
import { useTranslate } from "../i18n/language"
import { readComposeChoice, useLocalEcho, writeComposeChoice } from "../preferences/preferences"
import { createPiLabTrpcClient, type PiLabTrpcClient } from "../trpc/client"
import { connectionStatus } from "../trpc/connectionStatus"
import { startOnce } from "../trpc/launch"
import { ComposeLine } from "./ComposeLine"
import { KeySender } from "./keyInput"
import { PredictionEngine } from "./localEcho"
import { LocalEchoOverlay } from "./localEchoOverlay"
import { mapTerminalKeyEvent, type TerminalInputKind } from "./terminalKeyMapping"
import { TerminalStream } from "./terminalStream"

/**
 * This document's id toward the server's terminals: the server lets the client
 * that typed last keep its PTY size for a few seconds (`terminal.resize`).
 */
const CLIENT_ID = crypto.randomUUID()

/**
 * The next key's number in this document's sequence (shared by every pane,
 * since the daemon counts keys per client id). The daemon's echo ack names it.
 */
let nextKeySeq = 0

/** The daemon sends a key's echo ack this long after writing it (ECHO_ACK_DELAY_MS). */
const ECHO_ACK_DELAY_MS = 50

/** Agent terminals show the compose line on their own over this round trip, unless the user chose. */
const COMPOSE_DEFAULT_ROUND_TRIP_MS = 80

/**
 * Live terminal pane wired end-to-end to the `terminal` tRPC
 * router. It streams a PTY session's bytes into xterm.js,
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
 * Output arrives through `terminal.output` with resume (see terminalStream.ts):
 * after a dropped connection the pane subscribes again from the bytes its
 * emulator applied, so the screen continues without a gap or a duplicate.
 *
 * Size: the emulator always has the PTY's size. Focusing the pane asks the
 * server for this pane's size; the server refuses while another client typed
 * in the last few seconds, and then the pane shows the PTY with a margin (or
 * scaled down when the PTY is larger than the pane).
 *
 * Lifecycle ownership is deliberate: on unmount we unsubscribe and **detach**
 * (the subscription's teardown calls the daemon's `detach`) — we never `kill`.
 * The session lives in the separate pty-daemon process so it survives an Electron
 * reload; killing here would defeat that survival contract.
 *
 * Scrolling is xterm's own viewport, not Radix `ScrollArea`.
 *
 * Flow control (terminalStream.ts): a pane that is not shown (`visible` false,
 * or the window hidden) ends its subscription and resumes when shown. While
 * the user has a selection or has scrolled up, the server holds a skip to the
 * latest screen instead of replacing the view.
 */

interface TerminalProps {
  /** Whether this PTY hosts an interactive agent/TUI or an ordinary shell. */
  inputKind: TerminalInputKind
  /**
   * Injectable tRPC client for tests; defaults to the real IPC
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
  /** Whether the pane is on screen (a dock tab in front); hidden panes get no output. */
  visible: boolean
}

/**
 * Notices about the pane, shown in a banner above xterm. They are never written
 * into xterm: its screen must hold only the daemon's bytes, or resume and
 * snapshots would differ from the daemon's emulator.
 */
type NoticeKind = "write" | "resize" | "drop" | "exit" | "connection" | "start" | "input"

/** One banner line: fixed English wording (translated when shown) and an optional detail. */
interface Notice {
  text: string
  detail: string | null
}

/** Follows `document.visibilityState` (a minimised or hidden window). */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(document.visibilityState !== "hidden")
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden")
    document.addEventListener("visibilitychange", update)
    return () => document.removeEventListener("visibilitychange", update)
  }, [])
  return visible
}

export function Terminal({
  client,
  inputKind,
  sessionId,
  cwd,
  command,
  args,
  visible,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const t = useTranslate()
  const [localEcho] = useLocalEcho()
  const engineRef = useRef<PredictionEngine | null>(null)
  const localEchoRef = useRef(localEcho)
  localEchoRef.current = localEcho
  useEffect(() => {
    engineRef.current?.setMode(localEcho)
  }, [localEcho])
  const [notices, setNotices] = useState<Partial<Record<NoticeKind, Notice>>>({})
  /** The pane's session, once spawned or attached. */
  const [boundSession, setBoundSession] = useState<string | null>(null)
  /** The user's compose-line choice for this session (remembered), or null before one. */
  const [composeChoice, setComposeChoice] = useState<boolean | null>(null)
  /** The round trip measured from the stream's acks is over the compose default threshold. */
  const [slowLink, setSlowLink] = useState(false)
  const sendMessageRef = useRef<((text: string) => Promise<void>) | null>(null)
  const composeOn = composeChoice ?? (inputKind === "agent" && slowLink)
  const streamRef = useRef<TerminalStream | null>(null)
  const documentVisible = useDocumentVisible()
  const shown = visible && documentVisible
  const shownRef = useRef(shown)
  shownRef.current = shown
  useEffect(() => {
    streamRef.current?.setVisible(shown)
    // Predictions are cleared when the pane is hidden (the stream starts again when shown).
    if (!shown) {
      engineRef.current?.reset()
      overlayRef.current?.draw()
    }
  }, [shown])

  // Effect deps are intentionally empty: a terminal pane binds to one session for
  // its lifetime. Options are captured in a ref so changing a prop never
  // re-spawns/re-attaches (and never tears down a live agent session) mid-flight.
  const optionsRef = useRef({ client, inputKind, sessionId, cwd, command, args })
  optionsRef.current = { client, inputKind, sessionId, cwd, command, args }

  // Track the app's resolved mode and CSS-token palette so the terminal follows
  // Appearance changes without re-attaching the session.
  const xtermRef = useRef<XTerm | null>(null)
  const overlayRef = useRef<LocalEchoOverlay | null>(null)
  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => {
      if (xtermRef.current)
        xtermRef.current.options.theme = overlayRef.current?.theme() ?? currentTerminalTheme()
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

    // No convertEol: the daemon's emulator applies the same raw bytes, so snapshots match.
    const xterm = new XTerm({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: currentTerminalTheme(),
      // Local echo draws its predictions as decorations, a proposed API in xterm 5.5.
      allowProposedApi: true,
    })
    xtermRef.current = xterm
    const engine = new PredictionEngine(localEchoRef.current)
    engineRef.current = engine
    const overlay = new LocalEchoOverlay(xterm, engine, currentTerminalTheme)
    overlayRef.current = overlay
    /** When each of this pane's keys was sent (performance clock), by sequence number. */
    const keySentAt = new Map<number, number>()
    const redraw = (): void => overlay.draw()
    const writeParsed = xterm.onWriteParsed(redraw)
    const updateDisconnected = (): void => {
      const state = connectionStatus.state()
      engine.setDisconnected(state !== "connected")
      // Past the short-drop window: keys still waiting are not sent.
      if (state === "disconnected") keySender?.discardWaiting()
      redraw()
    }
    const unsubscribeStatus = connectionStatus.subscribe(updateDisconnected)
    const fitAddon = new FitAddon()
    xterm.loadAddon(fitAddon)
    xterm.open(container)

    // `cancelled` guards every async hop so a fast unmount (e.g. React 19
    // StrictMode's mount/unmount/remount) cleans up correctly and never writes
    // into a disposed terminal.
    let cancelled = false
    let sessionId: string | null = null
    let stream: TerminalStream | null = null
    let focusTarget: HTMLTextAreaElement | null = null
    /** The PTY size as the stream last reported it; null until the first start. */
    let ptySize: { cols: number; rows: number } | null = null
    /** Sends typed keys at most once, also across a dropped connection (keyInput.ts). */
    let keySender: KeySender | null = null
    /** Smoothed round trip of the stream's acks (ms), or null before the first. */
    let ackRoundTrip: number | null = null
    let inputDisposable: { dispose: () => void } | null = null
    const viewDisposables: { dispose: () => void }[] = []
    let resizeObserver: ResizeObserver | null = null
    let unregisterDictation: (() => void) | null = null
    const showNotice = (kind: NoticeKind, text: string, detail: string | null): void => {
      if (cancelled) return
      setNotices((current) => ({ ...current, [kind]: { text, detail } }))
    }
    const clearNotice = (kind: NoticeKind): void => {
      if (cancelled) return
      setNotices((current) => {
        if (current[kind] === undefined) return current
        const next = { ...current }
        delete next[kind]
        return next
      })
    }
    const errorText = (error: unknown): string =>
      error instanceof Error ? error.message : String(error)
    const reportTransportFailure = (operation: "write" | "resize", error: unknown): void => {
      showNotice(
        operation,
        operation === "write" ? "Terminal input failed" : "Terminal resize failed",
        errorText(error),
      )
    }

    /** Forward one input chunk exactly once, whether xterm generated or custom-mapped. */
    const forwardInput = (data: string): void => {
      if (cancelled || !sessionId || keySender === null) return
      const sentAt = performance.now()
      const seq = keySender.send(data)
      keySentAt.set(seq, sentAt)
      engine.key(data, seq, overlay.screen())
      redraw()
    }

    /** Insert native paths as one shell argument each, leaving submission to the user. */
    const onDrop = (event: DragEvent): void => {
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      if (!sessionId) {
        showNotice("drop", "The terminal is not ready for dropped paths", null)
        return
      }
      let paths: string[]
      try {
        paths = files.map((file) => window.piLab?.getPathForFile?.(file) ?? "")
      } catch {
        showNotice("drop", "Could not read a dropped file path", null)
        return
      }
      if (paths.some((path) => path.length === 0)) {
        showNotice("drop", "Could not read a dropped file path", null)
        return
      }
      clearNotice("drop")
      forwardInput(paths.map(quoteShellPath).join(" "))
      xterm.focus()
    }

    const onDragOver = (event: DragEvent): void => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault()
    }
    container.addEventListener("dragover", onDragOver)
    container.addEventListener("drop", onDrop)

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

    /** Show the PTY-sized emulator inside the pane: a margin, or scaled down when it is larger. */
    const fitView = (): void => {
      const element = xterm.element
      const screen = element?.querySelector<HTMLElement>(".xterm-screen")
      if (!element || !screen || screen.offsetWidth === 0 || screen.offsetHeight === 0) return
      const scale = Math.min(
        1,
        container.clientWidth / screen.offsetWidth,
        container.clientHeight / screen.offsetHeight,
      )
      element.style.transformOrigin = "0 0"
      element.style.transform = scale < 1 ? `scale(${scale})` : ""
    }

    /** Ask the server to give the PTY this pane's size (it refuses while another client types). */
    const takeSize = () => {
      if (cancelled || !sessionId) return
      const proposed = fitAddon.proposeDimensions()
      // The container can be momentarily zero-sized during layout; the next resize tick retries.
      if (!proposed || !(proposed.cols > 0) || !(proposed.rows > 0)) return
      if (ptySize && proposed.cols === ptySize.cols && proposed.rows === ptySize.rows) return
      void trpc.terminal.resize
        .mutate({ sessionId, cols: proposed.cols, rows: proposed.rows, clientId: CLIENT_ID })
        .then(
          () => clearNotice("resize"),
          (error: unknown) => reportTransportFailure("resize", error),
        )
    }

    const onPaneResize = () => {
      fitView()
      if (document.activeElement === focusTarget) takeSize()
    }

    /** Wire the streaming subscription + stdin forwarding for a session id. */
    const bind = (id: string) => {
      sessionId = id
      setBoundSession(id)
      setComposeChoice(readComposeChoice(id))
      sendMessageRef.current = async (text) => {
        await startOnce((messageId) =>
          trpc.terminal.sendMessage.mutate({ sessionId: id, messageId, text, clientId: CLIENT_ID }),
        )
      }

      // Stream daemon output into xterm, resuming after dropped connections.
      stream = new TerminalStream({
        subscribe: (input, handlers) => trpc.terminal.output.subscribe(input, handlers),
        ack: (input) => {
          // The acks' round trips give the link's round trip (for the compose-line default).
          const sentAt = performance.now()
          return trpc.terminal.ack.mutate(input).then((reply) => {
            const sample = performance.now() - sentAt
            ackRoundTrip =
              ackRoundTrip === null ? sample : ackRoundTrip + (sample - ackRoundTrip) / 8
            if (!cancelled) setSlowLink(ackRoundTrip > COMPOSE_DEFAULT_ROUND_TRIP_MS)
            return reply
          })
        },
        sessionId: id,
        emulator: {
          write: (data, applied) => xterm.write(data, applied),
          resize: (cols, rows) => xterm.resize(cols, rows),
        },
        dropPolicy: "keep",
        onSize: (cols, rows) => {
          ptySize = { cols, rows }
          engine.reset()
          redraw()
          requestAnimationFrame(fitView)
        },
        onStart: (echo) => {
          // A replay, refresh or snapshot (also a flow-control skip) clears every prediction.
          engine.reset()
          engine.setEcho(echo)
          redraw()
        },
        onEcho: (echo) => {
          engine.setEcho(echo)
          redraw()
        },
        onEchoAck: (ack) => {
          if (ack.clientId !== CLIENT_ID) return
          const sentAt = keySentAt.get(ack.seq)
          if (sentAt !== undefined) engine.roundTrip(performance.now() - sentAt - ECHO_ACK_DELAY_MS)
          for (const seq of keySentAt.keys()) if (seq <= ack.seq) keySentAt.delete(seq)
          engine.setEcho(ack.echo)
          engine.ack(ack.seq, overlay.screen())
          redraw()
        },
        onExit: (exitCode) => {
          showNotice("exit", "Session exited", `code ${exitCode ?? "?"}`)
        },
        onError: (message) => {
          showNotice("connection", "Terminal connection failed", message)
        },
      })
      streamRef.current = stream
      const consumedBy = stream
      keySender = new KeySender({
        write: async (data, key, signal) =>
          (
            await trpc.terminal.write.mutate(
              { sessionId: id, data, clientId: CLIENT_ID, key },
              { signal },
            )
          ).status,
        consumed: () => {
          const point = consumedBy.consumed()
          return point === null ? null : { generation: point.generation, offset: point.offset }
        },
        connection: () => connectionStatus.state(),
        nextSeq: () => nextKeySeq++,
        onLost: () =>
          showNotice("input", "Some input typed during the disconnect was not sent", null),
        onError: (error) => reportTransportFailure("write", error),
        onDelivered: () => clearNotice("write"),
      })
      stream.setVisible(shownRef.current)
      stream.open()

      // Hold skips while the user selects text or reads scrolled-up output.
      const updateHoldSkip = () => {
        const buffer = xterm.buffer.active
        stream?.setHoldSkip(xterm.hasSelection() || buffer.viewportY < buffer.baseY)
      }
      viewDisposables.push(xterm.onSelectionChange(updateHoldSkip), xterm.onScroll(updateHoldSkip))

      // Forward keystrokes (and pasted text) to the PTY's stdin.
      inputDisposable = xterm.onData(forwardInput)

      // Dictated text is typed like a dropped path: no Enter, so line breaks become spaces.
      unregisterDictation = registerDictationTarget({
        kind: "terminal",
        element: container,
        insert: (text) => forwardInput(text.replace(/\s*[\r\n]+\s*/gu, " ")),
        focus: () => xterm.focus(),
      })

      // Focusing the pane takes the PTY size; resizing the focused pane keeps it.
      focusTarget = xterm.textarea ?? null
      focusTarget?.addEventListener("focus", takeSize)
      resizeObserver = new ResizeObserver(onPaneResize)
      resizeObserver.observe(container)
      xterm.focus()
      takeSize()
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
        showNotice("start", "Failed to start terminal", errorText(error))
        return
      }
      if (cancelled) return
      bind(spawned.sessionId)
    })()

    return () => {
      cancelled = true
      container.removeEventListener("dragover", onDragOver)
      container.removeEventListener("drop", onDrop)
      resizeObserver?.disconnect()
      focusTarget?.removeEventListener("focus", takeSize)
      inputDisposable?.dispose()
      for (const disposable of viewDisposables) disposable.dispose()
      unregisterDictation?.()
      // Unsubscribe first: the subscription's server-side teardown `detach`es the
      // session (it is NOT killed), so the PTY persists across reload.
      stream?.close()
      streamRef.current = null
      writeParsed.dispose()
      unsubscribeStatus()
      overlay.dispose()
      overlayRef.current = null
      engineRef.current = null
      sendMessageRef.current = null
      xterm.dispose()
      xtermRef.current = null
    }
  }, [])

  const shownNotices = Object.entries(notices) as [NoticeKind, Notice][]
  return (
    <div style={{ ...paneStyle, display: "flex", flexDirection: "column" }}>
      {shownNotices.length > 0 ? (
        <div
          role="alert"
          data-testid="terminal-notice"
          className="flex shrink-0 flex-col gap-1 border-b px-3 py-1.5 text-xs"
        >
          {shownNotices.map(([kind, notice]) => (
            <div key={kind} className="flex items-center gap-2">
              <span className="flex-1">
                {notice.detail === null ? t(notice.text) : `${t(notice.text)}: ${notice.detail}`}
              </span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() =>
                  setNotices((current) => {
                    const next = { ...current }
                    delete next[kind]
                    return next
                  })
                }
              >
                {t("Dismiss")}
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div style={{ ...paneStyle, flex: 1, position: "relative" }}>
        <div
          ref={containerRef}
          data-testid="terminal"
          data-input-kind={inputKind}
          data-session-id={sessionId}
          style={{ ...paneStyle, background: "var(--background)" }}
        />
        {boundSession !== null ? (
          <button
            type="button"
            data-testid="terminal-compose-toggle"
            aria-pressed={composeOn}
            title={t("Compose line: type a message and send it with Enter")}
            className="absolute right-2 bottom-2 rounded-md border border-border bg-background px-1.5 py-0.5 text-muted-foreground text-xs hover:text-foreground"
            onClick={() => {
              writeComposeChoice(boundSession, !composeOn)
              setComposeChoice(!composeOn)
            }}
          >
            {t("Compose")}
          </button>
        ) : null}
      </div>
      {composeOn && boundSession !== null ? (
        <ComposeLine
          send={(text) => {
            const send = sendMessageRef.current
            if (send === null) return Promise.reject(new Error("the terminal is not ready"))
            return send(text)
          }}
          focusTerminal={() => xtermRef.current?.focus()}
        />
      ) : null}
    </div>
  )
}

/** Quote one path as a POSIX shell argument, including apostrophes. */
function quoteShellPath(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`
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
// box that fills its parent.
const paneStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  minHeight: 0,
  overflow: "hidden",
}
