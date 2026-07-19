import { describe, expect, test, vi } from "vitest"
import { EventBroker } from "./broker"
import { NotificationService, type NotificationServiceOptions } from "./service"
import type {
  NotificationActivation,
  NotificationDeliveryError,
  NotificationPreferences,
  NotificationRequest,
  NotificationSoundEvent,
} from "./types"

const REQUEST: NotificationRequest = {
  eventType: "agentInput",
  title: "Agent needs input",
  body: "Codex is waiting",
  target: {
    type: "agent",
    projectId: "project-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    agentId: "codex",
  },
}

function preferences(): NotificationPreferences {
  return {
    muted: false,
    agentInput: { enabled: true, sound: "chime" },
    agentTurnCompletion: { enabled: true, sound: "success" },
    terminalCompletion: { enabled: true, sound: "success" },
    workflowStart: { enabled: false, sound: "pulse" },
    workflowCompletion: { enabled: true, sound: "success" },
    workflowFailure: { enabled: true, sound: "alert" },
  }
}

function harness(overrides: {
  focused?: boolean
  supported?: boolean
  current?: NotificationPreferences
}): {
  service: NotificationService
  options: NotificationServiceOptions
  activations: NotificationActivation[]
  sounds: NotificationSoundEvent[]
  errors: NotificationDeliveryError[]
  handlers: Array<{ onClick: () => void; onFailure: (message: string) => void }>
} {
  const activations: NotificationActivation[] = []
  const sounds: NotificationSoundEvent[] = []
  const errors: NotificationDeliveryError[] = []
  const handlers: Array<{ onClick: () => void; onFailure: (message: string) => void }> = []
  const activationBroker = new EventBroker<NotificationActivation>()
  const soundBroker = new EventBroker<NotificationSoundEvent>()
  const errorBroker = new EventBroker<NotificationDeliveryError>()
  activationBroker.subscribe((event) => activations.push(event))
  soundBroker.subscribe((event) => sounds.push(event))
  errorBroker.subscribe((event) => errors.push(event))
  const options: NotificationServiceOptions = {
    native: {
      isSupported: () => overrides.supported ?? true,
      deliver: (_input, notificationHandlers) => {
        handlers.push(notificationHandlers)
      },
    },
    focus: {
      isFocused: () => overrides.focused ?? false,
      restoreAndFocus: vi.fn(),
    },
    getPreferences: () => overrides.current ?? preferences(),
    activations: activationBroker,
    sounds: soundBroker,
    errors: errorBroker,
    logger: { warn: vi.fn() },
  }
  return {
    service: new NotificationService(options),
    options,
    activations,
    sounds,
    errors,
    handlers,
  }
}

describe("NotificationService", () => {
  test("suppresses both banner and sound while PI Lab is focused", () => {
    const fixture = harness({ focused: true })

    expect(fixture.service.notify(REQUEST)).toBe("focused")
    expect(fixture.sounds).toEqual([])
    expect(fixture.handlers).toEqual([])
  })

  test("respects global mute and per-event toggles", () => {
    const muted = preferences()
    muted.muted = true
    expect(harness({ current: muted }).service.notify(REQUEST)).toBe("muted")

    const disabled = preferences()
    disabled.agentInput.enabled = false
    const fixture = harness({ current: disabled })
    expect(fixture.service.notify(REQUEST)).toBe("disabled")
    expect(fixture.sounds).toEqual([])
    expect(fixture.handlers).toEqual([])
  })

  test("uses a silent native banner and renderer sound, then routes exact click target", () => {
    const fixture = harness({})

    expect(fixture.service.notify(REQUEST)).toBe("delivered")
    expect(fixture.sounds).toEqual([{ sound: "chime" }])
    expect(fixture.handlers).toHaveLength(1)
    fixture.handlers[0]?.onClick()

    expect(fixture.options.focus.restoreAndFocus).toHaveBeenCalledOnce()
    expect(fixture.activations).toEqual([REQUEST.target])
  })

  test("logs and surfaces unsupported or failed native delivery without throwing", () => {
    const unsupported = harness({ supported: false })
    expect(() => unsupported.service.notify(REQUEST)).not.toThrow()
    expect(unsupported.errors[0]?.message).toMatch(/not supported/)

    const failed = harness({})
    failed.service.notify(REQUEST)
    failed.handlers[0]?.onFailure("unsigned application")
    expect(failed.options.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("unsigned application"),
    )
    expect(failed.errors[0]?.message).toContain("unsigned application")
  })

  test("native adapter exceptions are surfaced and do not crash the lifecycle monitor", () => {
    const fixture = harness({})
    fixture.options.native.deliver = () => {
      throw new Error("adapter exploded")
    }

    expect(() => fixture.service.notify(REQUEST)).not.toThrow()
    expect(fixture.errors[0]?.message).toContain("adapter exploded")
  })
})
