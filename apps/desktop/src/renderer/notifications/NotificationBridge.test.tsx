import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

interface SubscriptionHandlers {
  onData: (value: unknown) => void
  onError: (error: unknown) => void
}

const mocks = vi.hoisted(() => {
  const makeChannel = () => {
    let handlers: SubscriptionHandlers | null = null
    return {
      subscribe: vi.fn((_input: undefined, next: SubscriptionHandlers) => {
        handlers = next
        return { unsubscribe: vi.fn() }
      }),
      emit(value: unknown) {
        handlers?.onData(value)
      },
    }
  }
  return {
    navigate: vi.fn(),
    activation: makeChannel(),
    sound: makeChannel(),
    deliveryError: makeChannel(),
    playSound: vi.fn(async () => ({ status: "suppressed" as const })),
  }
})

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock("../trpc/react", () => ({
  useTRPCClient: () => ({
    notifications: {
      onActivation: mocks.activation,
      onSound: mocks.sound,
      onDeliveryError: mocks.deliveryError,
    },
  }),
}))

vi.mock("./sounds", async (importOriginal) => {
  const original = await importOriginal<typeof import("./sounds")>()
  return { ...original, playNotificationSound: mocks.playSound }
})

const { NotificationBridge } = await import("./NotificationBridge")

beforeEach(() => {
  mocks.navigate.mockReset()
  mocks.playSound.mockReset()
  mocks.playSound.mockResolvedValue({ status: "suppressed" })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("NotificationBridge", () => {
  test("routes an exact agent activation to its project and live session search target", async () => {
    render(<NotificationBridge />)
    mocks.activation.emit({
      type: "agent",
      projectId: "project-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      agentId: "codex",
      label: "Review agent",
    })

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledOnce())
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId",
      params: { projectId: "project-1" },
      search: {
        notificationId: "agent-1",
        notificationKind: "agent",
        notificationSessionId: "session-1",
        notificationWorkspaceId: "workspace-1",
        notificationAgentId: "codex",
        notificationLabel: "Review agent",
      },
    })
  })

  test("routes a terminal completion to the exact project session", async () => {
    render(<NotificationBridge />)
    mocks.activation.emit({
      type: "terminal",
      projectId: "project-1",
      workspaceId: "workspace-1",
      sessionId: "terminal-1",
      label: "Terminal",
    })

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledOnce())
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId",
      params: { projectId: "project-1" },
      search: {
        notificationId: "terminal-1",
        notificationKind: "terminal",
        notificationSessionId: "terminal-1",
        notificationWorkspaceId: "workspace-1",
        notificationLabel: "Terminal",
      },
    })
  })

  test("routes an exact workflow activation to its workflow and run", async () => {
    render(<NotificationBridge />)
    mocks.activation.emit({
      type: "workflow",
      workflowId: "workflow-1",
      runId: "run-9",
    })

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledOnce())
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/automations",
      search: {
        notificationId: "workflow-1",
        notificationWorkflowId: "workflow-1",
        notificationRunId: "run-9",
      },
    })
  })

  test("defensively suppresses runtime custom sounds while the document is focused", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
    render(<NotificationBridge />)
    mocks.sound.emit({ sound: "success" })

    await waitFor(() =>
      expect(mocks.playSound).toHaveBeenCalledWith("success", { suppressed: true }),
    )
  })

  test("surfaces a validated native-delivery failure and lets the user dismiss it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    render(<NotificationBridge />)
    mocks.deliveryError.emit({ message: "notifications are unsupported" })

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Native notification unavailable: notifications are unsupported",
    )
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification delivery error" }))
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
  })
})
