/// <reference types="vite/client" />
import { useCallback, useEffect, useRef, useState } from "react"
import stableIcon from "../../../assets/icons/icon.svg?url"
import alphaIcon from "../../../assets/icons/icon-alpha.svg?url"
import betaIcon from "../../../assets/icons/icon-beta.svg?url"
import type { BackgroundTrayBridge, BackgroundTraySnapshot } from "../../shared/backgroundTray"
import "./trayPopover.css"

const CHANNEL_ICONS = { alpha: alphaIcon, beta: betaIcon, stable: stableIcon } as const

/** Small background activity view shown from the macOS menu bar. */
export function TrayPopover() {
  const bridge = (window as Window & { piLab?: { backgroundTray?: BackgroundTrayBridge } }).piLab
    ?.backgroundTray
  const panelRef = useRef<HTMLElement | null>(null)
  const [snapshot, setSnapshot] = useState<BackgroundTraySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [channel, setChannel] = useState<keyof typeof CHANNEL_ICONS>("stable")

  useEffect(() => {
    let mounted = true
    void window.piLab?.appIcon
      ?.getChannel()
      .then((value) => {
        if (mounted) setChannel(value)
      })
      .catch((cause: unknown) => console.warn("[pi-lab] Tray icon channel unavailable:", cause))
    return () => {
      mounted = false
    }
  }, [])

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

  const run = useCallback((action: () => Promise<void>): void => {
    setError(null)
    void action().catch((cause: unknown) => {
      setError(`Could not complete action: ${String(cause)}`)
    })
  }, [])

  useEffect(() => {
    const panel = panelRef.current
    if (!panel || !bridge) return
    // Delegate blank-panel clicks while retaining the scroll container's native hit testing.
    // The separate Dashboard button provides the equivalent keyboard action.
    const onClick = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Element) || target.closest("button")) return
      const list = target.closest<HTMLElement>(".tray-projects")
      if (
        list &&
        list.offsetWidth > list.clientWidth &&
        event.clientX >= list.getBoundingClientRect().left + list.clientLeft + list.clientWidth
      )
        return
      run(() => bridge.openDashboard())
    }
    panel.addEventListener("click", onClick)
    return () => panel.removeEventListener("click", onClick)
  }, [bridge, run])

  const projects = snapshot?.projects ?? []

  return (
    <main ref={panelRef} className="tray-popover" data-testid="tray-popover">
      <button
        type="button"
        className="tray-dashboard"
        aria-label="Open Dashboard"
        onClick={() => {
          if (bridge) run(() => bridge.openDashboard())
        }}
      />
      <header className="tray-header">
        <img className="tray-brand-icon" src={CHANNEL_ICONS[channel]} alt="" />
        <strong className="tray-heading">PI Lab</strong>
        <span className="tray-project-count">{projects.length}</span>
      </header>

      <section className="tray-projects" aria-label="Projects active in the past seven days">
        {error ? (
          <p className="tray-error" role="alert">
            {error}
          </p>
        ) : null}
        {snapshot === null ? (
          error ? null : (
            <p className="tray-empty" role="status">
              Loading projects…
            </p>
          )
        ) : projects.length === 0 ? (
          <p className="tray-empty">No recent projects</p>
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
              {project.state !== "idle" ? (
                <span className="tray-project-dot" data-state={project.state} aria-hidden="true" />
              ) : null}
              <span className="tray-project-name" title={project.name}>
                {project.name}
              </span>
              <span className="tray-project-state">
                {project.state === "working"
                  ? "Working"
                  : project.state === "waiting"
                    ? "Waiting"
                    : ""}
              </span>
            </button>
          ))
        )}
      </section>

      {snapshot?.updateVersion ? (
        <footer className="tray-footer">
          <div className="tray-update">
            <span>Ready to update to {snapshot.updateVersion}</span>
            <button onClick={() => bridge?.restartToUpdate()} type="button">
              Restart to Update
            </button>
          </div>
        </footer>
      ) : null}
    </main>
  )
}
