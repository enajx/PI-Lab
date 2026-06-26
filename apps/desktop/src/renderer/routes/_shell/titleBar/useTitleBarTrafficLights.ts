import { useEffect } from "react"
import { useTRPCClient } from "../../../trpc/react"

/**
 * Drive the macOS traffic-light position from the shell layout. The lights belong
 * to the title-bar strip above the main panel — just right of the collapsed 56px
 * rail — only when the sidebar is BOTH shown and collapsed; otherwise (expanded, or
 * a sidebar-less route such as Settings) they sit at the default sidebar-header
 * inset. Fires the one-shot `system.setTrafficLightInset` mutation on mount and
 * whenever that derived placement flips (including route changes between a sidebar
 * route and Settings). The mutation is a darwin-only no-op elsewhere.
 */
export function useTitleBarTrafficLights({
  sidebarShown,
  collapsed,
}: {
  sidebarShown: boolean
  collapsed: boolean
}): void {
  const client = useTRPCClient()
  const inTitleBar = sidebarShown && collapsed
  useEffect(() => {
    void client.system.setTrafficLightInset.mutate({ inTitleBar })
  }, [client, inTitleBar])
}
