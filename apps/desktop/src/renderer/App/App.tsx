import { type CSSProperties, useEffect, useState } from "react"
import { createSkipperTrpcClient, type SkipperTrpcClient } from "../trpc/client"

type HealthState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; echo: string; appliedCount: number; latestTag: string | null }

interface AppProps {
  /** Injectable for tests (AGENTS.md §14); defaults to the real IPC client. */
  client?: SkipperTrpcClient
}

/**
 * Foundation renderer (AGENTS.md §11 P3). It does one thing: prove the full path
 * — renderer → IPC → main → SQLite — by calling `health.ping` + `health.dbVersion`
 * and rendering an `app-ready` marker once both resolve. No router, no features
 * yet; those land in later phases.
 */
export function App({ client }: AppProps) {
  const [state, setState] = useState<HealthState>({ phase: "loading" })

  useEffect(() => {
    const trpc = client ?? createSkipperTrpcClient()
    let cancelled = false

    Promise.all([trpc.health.ping.query({ message: "hello" }), trpc.health.dbVersion.query()])
      .then(([ping, db]) => {
        if (cancelled) return
        setState({
          phase: "ready",
          echo: ping.echo,
          appliedCount: db.appliedCount,
          latestTag: db.latestTag,
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({
          phase: "error",
          message: error instanceof Error ? error.message : String(error),
        })
      })

    return () => {
      cancelled = true
    }
  }, [client])

  if (state.phase === "loading") {
    return (
      <main style={shell} data-testid="app-loading">
        <p>Starting Skipper…</p>
      </main>
    )
  }

  if (state.phase === "error") {
    return (
      <main style={shell} data-testid="app-error">
        <h1 style={heading}>Skipper failed to start</h1>
        {/* Error text must be selectable (AGENTS.md §12.7). */}
        <pre style={errorText}>{state.message}</pre>
      </main>
    )
  }

  return (
    <main style={shell} data-testid="app-ready">
      <h1 style={heading}>Skipper</h1>
      <p>Electron shell is up. Local database is migrated.</p>
      <dl style={metaList}>
        <dt style={metaKey}>DB version</dt>
        <dd style={metaVal} data-testid="db-version">
          {state.latestTag ?? `applied:${state.appliedCount}`}
        </dd>
        <dt style={metaKey}>Migrations applied</dt>
        <dd style={metaVal} data-testid="db-applied-count">
          {state.appliedCount}
        </dd>
        <dt style={metaKey}>Health echo</dt>
        <dd style={metaVal} data-testid="health-echo">
          {state.echo}
        </dd>
      </dl>
    </main>
  )
}

// Plain inline styles — Tailwind/shadcn arrive in a later phase. Non-pure-black
// background per the theme guidance (AGENTS.md §7).
const shell: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  minHeight: "100vh",
  margin: 0,
  padding: 32,
  background: "#101014",
  color: "#e6e6ea",
  fontFamily: "system-ui, -apple-system, sans-serif",
}

const heading: CSSProperties = { margin: 0, fontSize: 24, fontWeight: 600 }

const metaList: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "max-content 1fr",
  columnGap: 16,
  rowGap: 6,
  margin: 0,
}

const metaKey: CSSProperties = { color: "#9a9aa6", fontSize: 13 }
const metaVal: CSSProperties = { margin: 0, fontVariantNumeric: "tabular-nums" }

const errorText: CSSProperties = {
  whiteSpace: "pre-wrap",
  userSelect: "text",
  cursor: "text",
  color: "#ff8d8d",
}
