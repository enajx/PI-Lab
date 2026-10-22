import { Button } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { APP_ICON_DEFAULT_SELECTION } from "../../../../../shared/appIcon"
import { drainFileOperations } from "../../../../Editor/hooks/useEditorBuffers/fileOperations"
import { setInterfaceLanguage } from "../../../../i18n/language"
import {
  alphaProjectsHaveUnsavedWork,
  clearAlphaLocalPreferences,
  clearAlphaProjectUiState,
} from "../../../../preferences/resetAlphaPreferences"
import { useTRPC } from "../../../../trpc/react"
import { workspaceRecovery } from "../../projects/-workspaceState"

/** Alpha-only tools for repeating project creation and first-run testing. */
export function AlphaTestingResets() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [isAlpha, setIsAlpha] = useState(false)
  const [busy, setBusy] = useState<"projects" | "settings" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const startAtLogin = useQuery(trpc.system.startAtLogin.queryOptions())
  const menuBarIcon = useQuery(trpc.system.menuBarIcon.queryOptions())
  const clearProjects = useMutation(trpc.alphaTesting.clearProjects.mutationOptions())
  const resetPreferences = useMutation(trpc.alphaTesting.resetPreferences.mutationOptions())
  const setStartAtLogin = useMutation(trpc.system.setStartAtLogin.mutationOptions())
  const setMenuBarIcon = useMutation(trpc.system.setMenuBarIcon.mutationOptions())

  useEffect(() => {
    let active = true
    void window.piLab?.appIcon
      ?.getChannel()
      .then((channel) => {
        if (active) setIsAlpha(channel === "alpha")
      })
      .catch((cause: unknown) => {
        if (active) setError(`Could not check the app channel: ${String(cause)}`)
      })
    return () => {
      active = false
    }
  }, [])

  if (!isAlpha) return null

  const onClearProjects = async () => {
    if (
      !window.confirm(
        "Forget every Alpha project, including archived projects? Project folders will stay on disk. Close active sessions first.",
      )
    )
      return
    setBusy("projects")
    setError(null)
    try {
      await drainFileOperations()
      const projects = await queryClient.fetchQuery(trpc.projects.list.queryOptions())
      const recovery = workspaceRecovery()
      recovery.flush()
      if (
        alphaProjectsHaveUnsavedWork(
          projects.map((project) => project.id),
          recovery,
        )
      ) {
        throw new Error("Save or close unsaved project tabs before clearing the project list")
      }
      await clearProjects.mutateAsync()
      clearAlphaProjectUiState(
        window.localStorage,
        projects.map((project) => project.id),
      )
      await queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() })
      window.location.hash = "#/"
      window.location.reload()
    } catch (cause) {
      setError(String(cause))
      setBusy(null)
    }
  }

  const onResetSettings = async () => {
    if (
      !window.confirm(
        "Reset Alpha preferences and repeat first-run setup? Projects, project files, connected data, and saved credentials will stay.",
      )
    )
      return
    setBusy("settings")
    setError(null)
    try {
      await resetPreferences.mutateAsync()
      if (startAtLogin.data?.available) await setStartAtLogin.mutateAsync({ enabled: false })
      if (menuBarIcon.data?.available) await setMenuBarIcon.mutateAsync({ visible: true })
      await window.piLab?.appIcon?.set({
        ...APP_ICON_DEFAULT_SELECTION,
        alphaWhiteBackground: true,
        joyplotPalette: "viridis",
        piPalette: "viridis",
      })
      await setInterfaceLanguage("en")
      clearAlphaLocalPreferences(window.localStorage)
      window.location.reload()
    } catch (cause) {
      setError(String(cause))
      setBusy(null)
    }
  }

  return (
    <div className="border-border border-t px-4 py-4" data-testid="alpha-testing-resets">
      <h3 className="text-sm font-medium">Alpha testing</h3>
      <p className="mt-1 text-muted-foreground text-xs">
        Repeat project and setup flows without changing Stable or Beta.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy !== null}
          data-testid="alpha-clear-projects"
          onClick={() => void onClearProjects()}
        >
          Clear project list
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy !== null}
          data-testid="alpha-reset-settings"
          onClick={() => void onResetSettings()}
        >
          Reset settings
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  )
}
