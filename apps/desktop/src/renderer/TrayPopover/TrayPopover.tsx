import { useEffect, useState } from "react"
import type { BackgroundTrayBridge, BackgroundTraySnapshot } from "../../shared/backgroundTray"
import "./trayPopover.css"

/** Small background activity view shown from the macOS menu bar. */
export function TrayPopover() {
  const bridge = (window as Window & { piLab?: { backgroundTray?: BackgroundTrayBridge } }).piLab
    ?.backgroundTray
  const [snapshot, setSnapshot] = useState<BackgroundTraySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!bridge) {
      setError("Background controls are unavailable.")
      return
    }
    let mounted = true
    let receivedChange = false
    const unsubscribe = bridge.subscribe((next) => {
      receivedChange = true
      setSnapshot(next)
      setError(null)
    })
    void bridge
      .getSnapshot()
      .then((next) => {
        if (mounted && !receivedChange) setSnapshot(next)
      })
      .catch((cause: unknown) => {
        if (mounted && !receivedChange) setError(`Could not load projects: ${String(cause)}`)
      })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [bridge])

  const run = (action: () => Promise<void>): void => {
    setError(null)
    void action().catch((cause: unknown) => {
      setError(`Could not complete action: ${String(cause)}`)
    })
  }

  const projects = snapshot?.projects ?? []

  return (
    <main className="tray-popover" data-testid="tray-popover">
      <header className="tray-header">
        <span className="tray-brand-mark" aria-hidden="true">
          π
        </span>
        <span className="tray-brand-copy">
          <strong>PI Lab</strong>
          <span>Background activity</span>
        </span>
        <span className="tray-project-count">
          {projects.length} {projects.length === 1 ? "project" : "projects"}
        </span>
      </header>

      <section className="tray-projects" aria-label="Projects with agent activity">
        {snapshot === null ? (
          <p className="tray-empty" role="status">
            {error ? "Projects unavailable" : "Loading projects…"}
          </p>
        ) : projects.length === 0 ? (
          <p className="tray-empty">No active projects</p>
        ) : (
          projects.map((project) => (
            <button
              className="tray-project-row"
              data-state={project.state}
              key={project.id}
              onClick={() => {
                if (bridge) run(() => bridge.openProject(project.id))
              }}
              type="button"
            >
              <span className="tray-project-face" data-state={project.state} aria-hidden="true">
                <span className="tray-project-eyes" />
              </span>
              <span className="tray-project-name" title={project.name}>
                {project.name}
              </span>
              <span className="tray-project-state">
                {project.state === "working" ? "Working" : "Waiting"}
              </span>
              <span className="tray-project-chevron" aria-hidden="true">
                ›
              </span>
            </button>
          ))
        )}
      </section>

      {error ? (
        <p className="tray-error" role="alert">
          {error}
        </p>
      ) : null}

      <footer className="tray-footer">
        <div className="tray-primary-actions">
          <button
            className="tray-open-app"
            disabled={!bridge}
            onClick={() => {
              if (bridge) run(() => bridge.openApp())
            }}
            type="button"
          >
            Open PI Lab
          </button>
          <button
            className="tray-open-file"
            disabled={!bridge}
            onClick={() => {
              if (bridge) run(() => bridge.openFile())
            }}
            type="button"
          >
            Open File
          </button>
        </div>
        <button
          className="tray-quit"
          disabled={!bridge}
          onClick={() => bridge?.quit()}
          type="button"
        >
          Quit
        </button>
      </footer>
    </main>
  )
}
