import { expect, test, vi } from "vitest"
import type { ServerClient } from "../server/client"
import type { DataCompatibility } from "./compatibility"
import type { PublicUpdateController } from "./controller"
import { startServerUpdates } from "./serverUpdates"

/**
 * Injected stand-ins for the server client and the controller; the real
 * server subscription is covered in server/server.test.ts. `send` plays the
 * server: after a WebSocket reconnect tRPC subscribes again and the server
 * sends the current channel again.
 */
function harness() {
  let onData: ((channel: string) => void) | null = null
  const client = {
    server: {
      updateCompatibility: { query: async () => ({}) as DataCompatibility },
      onPublicUpdateChannel: {
        subscribe: (_input: undefined, handlers: { onData: (channel: string) => void }) => {
          onData = handlers.onData
          return { unsubscribe: () => undefined }
        },
      },
    },
  } as unknown as ServerClient
  const controller = {
    start: vi.fn(async () => undefined),
    selectedChannelChanged: vi.fn(),
  }
  const channelChanged = vi.fn()
  return {
    client,
    controller,
    channelChanged,
    send: async (channel: string) => {
      await vi.waitFor(() => expect(onData).not.toBeNull())
      onData?.(channel)
    },
    start: () =>
      startServerUpdates(
        client,
        () => controller as unknown as PublicUpdateController,
        channelChanged,
      ),
  }
}

test("a reconnect resending the same channel is not a channel change", async () => {
  const h = harness()
  const started = h.start()
  await h.send("beta")
  await started
  expect(h.controller.start).toHaveBeenCalledExactlyOnceWith("beta")
  await h.send("beta")
  await h.send("beta")
  expect(h.channelChanged).not.toHaveBeenCalled()
  expect(h.controller.selectedChannelChanged).not.toHaveBeenCalled()
  await h.send("stable")
  await h.send("stable")
  expect(h.channelChanged).toHaveBeenCalledOnce()
  expect(h.controller.selectedChannelChanged).toHaveBeenCalledExactlyOnceWith("stable")
})
