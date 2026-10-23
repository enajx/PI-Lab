import { useEffect, useState } from "react"
import type { UpdateSnapshot } from "../../shared/updates"
import { UpdateNotice } from "./UpdateNotice"

/** Subscribe above routes so navigation does not replay or interrupt a notice. */
export function UpdateFeedback() {
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const bridge = window.piLab?.updates
    if (!bridge) return
    let active = true
    const receive = (next: UpdateSnapshot) => {
      if (active) setError(null)
      if (active)
        setSnapshot((previous) =>
          !previous || next.revision >= previous.revision ? next : previous,
        )
    }
    const onError = (event: Event) =>
      setError(`Could not check for updates: ${(event as CustomEvent<string>).detail}`)
    window.addEventListener("pi-lab-update-error", onError)
    const unsubscribe = bridge.subscribe(receive)
    void bridge
      .snapshot()
      .then(receive)
      .catch((error: unknown) => {
        if (active) setError(`Could not read update status: ${String(error)}`)
      })
    return () => {
      active = false
      unsubscribe()
      window.removeEventListener("pi-lab-update-error", onError)
    }
  }, [])
  const message = error ?? snapshot?.message
  return message ? <UpdateNotice key={snapshot?.revision ?? "error"} message={message} /> : null
}

/** Both entry points invoke the same main-process check. */
export function requestUpdateCheck(): void {
  void window.piLab?.updates?.check().catch((error: unknown) => {
    window.dispatchEvent(new CustomEvent("pi-lab-update-error", { detail: String(error) }))
  })
}
