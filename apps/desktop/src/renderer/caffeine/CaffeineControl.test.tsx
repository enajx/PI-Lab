import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { AppProviders } from "../providers/AppProviders"
import { createFakeTrpcClient } from "../test/fakeTrpcClient"
import { CaffeineControl, nextCaffeineMode } from "./CaffeineControl"
import type { CaffeineStatus } from "./useCaffeine"

function renderControl(initialStatus: CaffeineStatus) {
  let status = initialStatus
  const modeUpdates = vi.fn((input: unknown) => {
    const mode = (input as { mode: CaffeineStatus["mode"] }).mode
    status = { ...status, mode, held: mode !== "off" }
    return status
  })
  const client = createFakeTrpcClient({
    "caffeine.status": () => status,
    "caffeine.setMode": modeUpdates,
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <CaffeineControl />
    </AppProviders>,
  )
  return { modeUpdates }
}

describe("CaffeineControl", () => {
  test("cycles Off to On to Auto to Off through the public caffeine mutation", async () => {
    const { modeUpdates } = renderControl({
      mode: "off",
      scope: "system-only",
      held: false,
    })
    const control = await screen.findByTestId("caffeine-control")

    fireEvent.click(control)
    await waitFor(() => expect(modeUpdates).toHaveBeenLastCalledWith({ mode: "on" }))
    await waitFor(() => expect(control.getAttribute("data-mode")).toBe("on"))

    fireEvent.click(control)
    await waitFor(() => expect(modeUpdates).toHaveBeenLastCalledWith({ mode: "auto" }))
    await waitFor(() => expect(control.getAttribute("data-mode")).toBe("auto"))

    fireEvent.click(control)
    await waitFor(() => expect(modeUpdates).toHaveBeenLastCalledWith({ mode: "off" }))
    await waitFor(() => expect(control.getAttribute("data-mode")).toBe("off"))
  })

  test("keeps sleep-prevention help simple without active/idle or orange on-state styling", async () => {
    renderControl({ mode: "on", scope: "system-plus-display", held: true })
    const control = await screen.findByRole("button", { name: /Caffeine On.*switch to Auto/ })

    expect(control.textContent).toContain("On")
    expect(control.textContent).not.toMatch(/Active|Idle/)
    expect(control.getAttribute("title")).toBe("Prevent the computer from sleeping.")
    expect(control.getAttribute("data-feature-help")).toBe("Prevent the computer from sleeping.")
    expect(control.getAttribute("data-mode")).toBe("on")
    expect(control.getAttribute("data-held")).toBe("true")
    expect(control.classList.contains("app-no-drag")).toBe(true)
    expect(control.classList.contains("caffeine-control")).toBe(true)
    expect(control.className).not.toMatch(/amber|orange/)
  })

  test("does not render an active visual treatment while the blocker is held", async () => {
    renderControl({ mode: "auto", scope: "system-only", held: true })

    const control = await screen.findByTestId("caffeine-control")
    await waitFor(() => expect(control.getAttribute("data-held")).toBe("true"))
    expect(screen.queryByTestId("caffeine-animation")).toBeNull()
  })

  test("reports idle Auto without an active visual treatment", async () => {
    renderControl({ mode: "auto", scope: "system-only", held: false })

    const control = await screen.findByTestId("caffeine-control")
    expect(control.getAttribute("data-held")).toBe("false")
  })

  test("defines the complete three-state cycle", () => {
    expect(nextCaffeineMode("off")).toBe("on")
    expect(nextCaffeineMode("on")).toBe("auto")
    expect(nextCaffeineMode("auto")).toBe("off")
  })
})
