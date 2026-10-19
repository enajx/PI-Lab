import { useEffect, useRef, useState } from "react"
import type { QuickEditBridge } from "../../shared/quickEdit"

type OptionsResult = Awaited<ReturnType<QuickEditBridge["pythonOptions"]>>

/** List Python environments only when the user opens the Quick Editor picker. */
export function QuickPythonEnvironmentPicker({ targetId }: { targetId: string }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<OptionsResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const bridge = window.piLab?.quickEdit

  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", dismiss)
    document.addEventListener("keydown", dismissOnEscape)
    return () => {
      document.removeEventListener("mousedown", dismiss)
      document.removeEventListener("keydown", dismissOnEscape)
    }
  }, [open])

  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    setLoading(true)
    setError(null)
    if (!bridge) {
      setError("Python environments are unavailable.")
      setLoading(false)
      return
    }
    void bridge.pythonOptions(targetId).then(
      (next) => {
        setResult(next)
        setLoading(false)
      },
      (cause: unknown) => {
        setError(`Could not list Python environments: ${String(cause)}`)
        setLoading(false)
      },
    )
  }

  const select = (path: string | null): void => {
    if (!bridge) return
    setLoading(true)
    setError(null)
    void bridge.pythonSelect(targetId, path).then(
      (runtime) => {
        setResult((current) => (current ? { ...current, runtime } : null))
        setOpen(false)
        setLoading(false)
      },
      (cause: unknown) => {
        setError(`Could not select Python environment: ${String(cause)}`)
        setLoading(false)
      },
    )
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="quick-python-environment"
        aria-label="Python"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggle}
        className="rounded px-1 hover:bg-accent hover:text-foreground"
      >
        {result?.runtime.version ? `Python ${result.runtime.version}` : "Python"} ▾
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Python environments"
          className="absolute right-0 bottom-full z-30 mb-1 max-h-[70vh] w-72 overflow-y-auto rounded border border-border bg-background p-1 text-foreground shadow-lg"
        >
          {loading ? <div className="px-2 py-1.5 text-xs">Finding environments…</div> : null}
          {error ? (
            <div role="alert" className="px-2 py-1.5 text-destructive text-xs">
              {error}
            </div>
          ) : null}
          {!loading && result ? (
            <>
              <div
                data-testid="quick-python-active-interpreter"
                className="border-border border-b px-2 py-2 text-xs"
              >
                <div className="font-semibold text-foreground">Active interpreter</div>
                <div className="mt-1">
                  {result.runtime.runStrategy.kind === "uv-project"
                    ? "uv project · environment not created"
                    : result.runtime.displayName}
                </div>
                <div data-testid="quick-python-active-version" className="mt-1">
                  {result.runtime.runStrategy.kind === "uv-project"
                    ? "Version available after the first Run"
                    : result.runtime.version
                      ? `Python ${result.runtime.version}`
                      : "Python version unavailable"}
                </div>
                <div
                  data-testid="quick-python-active-path"
                  className="mt-1 break-all font-mono text-foreground"
                >
                  {result.runtime.interpreterPath ??
                    (result.runtime.runStrategy.command
                      ? `${result.runtime.runStrategy.command} ${result.runtime.runStrategy.argsPrefix.join(" ")}`
                      : "No Python interpreter available")}
                </div>
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={() => select(null)}
                className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
              >
                Auto-detect
              </button>
              {result.options.map((option) => (
                <button
                  key={option.path}
                  type="button"
                  role="menuitem"
                  title={option.interpreterPath}
                  onClick={() => select(option.path)}
                  className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                >
                  <span className="block">{option.displayName}</span>
                  <span className="block break-all font-mono text-muted-foreground text-[10px]">
                    {option.interpreterPath}
                  </span>
                </button>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
