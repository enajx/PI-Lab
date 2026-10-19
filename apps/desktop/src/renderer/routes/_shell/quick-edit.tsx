import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { useSidebarCollapsed } from "../../preferences/preferences"
import { QuickEditor } from "../../QuickEditor/QuickEditor"
import { stripOuterQuery } from "../../QuickEditor/routeTarget"
import { useTRPC, useTRPCClient } from "../../trpc/react"
import { useNewFileController } from "./components/NewFileController"
import { setPendingOpenFile } from "./projects/-pendingOpenFile"

/** Keep an outside-project quick file open alongside the full app's sidebar. */
export const Route = createFileRoute("/_shell/quick-edit")({
  validateSearch: (search) => z.object({ target: z.string().min(1).optional() }).parse(search),
  component: QuickEditorRoute,
})

function QuickEditorRoute() {
  const { target } = Route.useSearch()
  const id = target ? stripOuterQuery(target) : undefined
  const trpc = useTRPC()
  const client = useTRPCClient()
  const newFileController = useNewFileController()
  const settings = useQuery(trpc.settings.get.queryOptions())
  const [sidebarCollapsed] = useSidebarCollapsed()
  const saveInProject = async (content: string): Promise<string | null> => {
    const destination = await newFileController.chooseNewFile("")
    if (!destination) return null
    const workspace = await client.workspaces.ensureMain.mutate({
      projectId: destination.projectId,
    })
    const result = await client.files.write.mutate({
      workspaceId: workspace.id,
      relPath: destination.relPath,
      content,
    })
    if (!result.matchesWrittenContent) throw new Error("Saved file differs from editor content")
    setPendingOpenFile(destination.projectId, destination.relPath)
    return `/projects/${encodeURIComponent(destination.projectId)}`
  }
  return (
    <QuickEditor
      key={id ?? "untitled"}
      targetId={id}
      fullApp
      sidebarCollapsed={sidebarCollapsed}
      editorTheme={settings.data?.editor.editorTheme}
      customEditorThemes={settings.data?.editor.customEditorThemes}
      saveInProject={saveInProject}
    />
  )
}
