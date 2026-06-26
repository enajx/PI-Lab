import { QueryClient } from "@tanstack/react-query"
import { render, waitFor } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { AppProviders } from "../../../providers/AppProviders"
import { createFakeTrpcClient } from "../../../test/fakeTrpcClient"
import { useTitleBarTrafficLights } from "./useTitleBarTrafficLights"

/**
 * The driving hook should ask the main process to move the macOS traffic lights to
 * the title bar only when the sidebar is shown AND collapsed — and back to the
 * default inset for the expanded or sidebar-less (Settings) cases. We capture the
 * `system.setTrafficLightInset` calls through a fake tRPC client.
 */
function renderWith(props: { sidebarShown: boolean; collapsed: boolean }) {
  const calls: { inTitleBar: boolean }[] = []
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient({
    "system.setTrafficLightInset": (input) => {
      calls.push(input as { inTitleBar: boolean })
      return { applied: true }
    },
  })

  function Harness({ sidebarShown, collapsed }: { sidebarShown: boolean; collapsed: boolean }) {
    useTitleBarTrafficLights({ sidebarShown, collapsed })
    return null
  }

  const utils = render(
    <AppProviders client={client} queryClient={queryClient}>
      <Harness {...props} />
    </AppProviders>,
  )
  return { calls, ...utils }
}

describe("useTitleBarTrafficLights", () => {
  test("moves the lights into the title bar when the sidebar is shown and collapsed", async () => {
    const { calls } = renderWith({ sidebarShown: true, collapsed: true })
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(calls.at(-1)).toEqual({ inTitleBar: true })
  })

  test("keeps the lights at the default inset when the sidebar is expanded", async () => {
    const { calls } = renderWith({ sidebarShown: true, collapsed: false })
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(calls.at(-1)).toEqual({ inTitleBar: false })
  })

  test("keeps the lights at the default inset on a sidebar-less route even if collapsed", async () => {
    const { calls } = renderWith({ sidebarShown: false, collapsed: true })
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(calls.at(-1)).toEqual({ inTitleBar: false })
  })
})
