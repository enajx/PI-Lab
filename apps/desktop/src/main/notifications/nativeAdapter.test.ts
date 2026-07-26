import { describe, expect, test, vi } from "vitest"
import { createNativeNotificationAdapter, type PlatformNotificationInput } from "./nativeAdapter"

function notificationHarness() {
  const once = vi.fn()
  const show = vi.fn()
  const create = vi.fn((input: PlatformNotificationInput) => ({ ...input, once, show }))
  return { create, once, show }
}

describe("createNativeNotificationAdapter", () => {
  test.each([
    "linux",
    "win32",
  ] as const)("passes the resolved Pi tile to native notification construction on %s", (platform) => {
    const harness = notificationHarness()
    const adapter = createNativeNotificationAdapter("/repo/icons/icon.png", {
      platform,
      isSupported: () => true,
      create: harness.create,
    })

    adapter.deliver(
      { title: "Agent waiting", body: "Codex needs input", silent: true },
      { onClick: vi.fn(), onFailure: vi.fn() },
    )

    expect(harness.create).toHaveBeenCalledWith({
      title: "Agent waiting",
      body: "Codex needs input",
      silent: true,
      icon: "/repo/icons/icon.png",
    })
    expect(harness.show).toHaveBeenCalledOnce()
  })

  test("omits a content icon on macOS so the app bundle provides sender identity once", () => {
    const harness = notificationHarness()
    const adapter = createNativeNotificationAdapter("/repo/icons/icon.png", {
      platform: "darwin",
      isSupported: () => true,
      create: harness.create,
    })

    adapter.deliver(
      { title: "Agent waiting", body: "Codex needs input", silent: true },
      { onClick: vi.fn(), onFailure: vi.fn() },
    )

    expect(harness.create).toHaveBeenCalledWith({
      title: "Agent waiting",
      body: "Codex needs input",
      silent: true,
    })
  })

  test("omits the icon when the asset could not be resolved", () => {
    const harness = notificationHarness()
    const adapter = createNativeNotificationAdapter(null, {
      platform: "win32",
      isSupported: () => true,
      create: harness.create,
    })

    adapter.deliver(
      { title: "Workflow complete", body: "Analysis finished", silent: true },
      { onClick: vi.fn(), onFailure: vi.fn() },
    )

    expect(harness.create).toHaveBeenCalledWith({
      title: "Workflow complete",
      body: "Analysis finished",
      silent: true,
    })
  })

  test("wires click and failure handlers through the native instance", () => {
    const harness = notificationHarness()
    const onClick = vi.fn()
    const onFailure = vi.fn()
    const adapter = createNativeNotificationAdapter("/repo/icons/icon.png", {
      platform: "linux",
      isSupported: () => true,
      create: harness.create,
    })

    adapter.deliver(
      { title: "Agent waiting", body: "Codex needs input", silent: true },
      { onClick, onFailure },
    )

    expect(harness.once).toHaveBeenCalledWith("click", expect.any(Function))
    expect(harness.once).toHaveBeenCalledWith("close", expect.any(Function))
    expect(harness.once).toHaveBeenCalledWith("failed", expect.any(Function))
  })

  test("retains the native wrapper until Electron reports click, close, or failure", () => {
    const harness = notificationHarness()
    const retained = new Set<ReturnType<typeof harness.create>>()
    const onClick = vi.fn()
    const adapter = createNativeNotificationAdapter("/repo/icons/icon.png", {
      platform: "win32",
      isSupported: () => true,
      create: harness.create,
      retainedNotifications: retained,
    })

    adapter.deliver(
      { title: "Agent waiting", body: "Codex needs input", silent: true },
      { onClick, onFailure: vi.fn() },
    )

    const notification = harness.create.mock.results[0]?.value
    if (!notification) throw new Error("Expected a native notification")
    expect(retained.has(notification)).toBe(true)
    const clickListener = harness.once.mock.calls.find(([event]) => event === "click")?.[1]
    if (typeof clickListener !== "function") throw new Error("Expected a click listener")
    clickListener()
    expect(onClick).toHaveBeenCalledOnce()
    expect(retained.has(notification)).toBe(false)
  })
})
