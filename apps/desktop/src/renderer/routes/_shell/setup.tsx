import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { FirstRunSetup } from "../../setup/FirstRunSetup"

export const Route = createFileRoute("/_shell/setup")({
  component: SetupView,
})

export function SetupView() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const finish = async (): Promise<void> => {
    const bridge = window.piLab?.quickEdit
    if (bridge) {
      const target = await bridge.current()
      if (target) {
        await bridge.showFull(target.id)
        return
      }
    }
    await navigate({ to: "/", replace: true })
  }
  return (
    <>
      {error ? <div role="alert">{error}</div> : null}
      <FirstRunSetup
        onClose={() => {
          void finish().catch((cause: unknown) => {
            setError(`Could not reopen the file: ${String(cause)}`)
          })
        }}
      />
    </>
  )
}
