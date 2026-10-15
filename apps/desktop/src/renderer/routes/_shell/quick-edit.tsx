import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { useSidebarCollapsed } from "../../preferences/preferences"
import { QuickEditor } from "../../QuickEditor/QuickEditor"
import { stripOuterQuery } from "../../QuickEditor/routeTarget"
import { useTRPC } from "../../trpc/react"

/** Keep an outside-project quick file open alongside the full app's sidebar. */
export const Route = createFileRoute("/_shell/quick-edit")({
  validateSearch: (search) => z.object({ target: z.string().min(1) }).parse(search),
  component: QuickEditorRoute,
})

function QuickEditorRoute() {
  const { target } = Route.useSearch()
  const id = stripOuterQuery(target)
  const trpc = useTRPC()
  const settings = useQuery(trpc.settings.get.queryOptions())
  const [sidebarCollapsed] = useSidebarCollapsed()
  return (
    <QuickEditor
      key={id}
      targetId={id}
      fullApp
      sidebarCollapsed={sidebarCollapsed}
      editorTheme={settings.data?.editor.editorTheme}
      customEditorThemes={settings.data?.editor.customEditorThemes}
    />
  )
}
