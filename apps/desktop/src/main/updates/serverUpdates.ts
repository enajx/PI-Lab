import type { ServerClient } from "../server/client"
import type { DataCompatibility } from "./compatibility"
import type { PublicUpdateController } from "./controller"

/** The running public updater and how to stop following channel changes. */
export interface ServerUpdates {
  controller: PublicUpdateController
  stop: () => void
}

/**
 * Start public update checks with what the PI Lab server owns: the data
 * format the database uses and the selected update channel. Channel changes
 * saved on the server reach the controller through a subscription; each real
 * change (not a resent current value) also calls `channelChanged`. Installing and native feedback stay with the
 * caller (Electron).
 */
export async function startServerUpdates(
  client: ServerClient,
  createController: (compatibility: DataCompatibility) => PublicUpdateController,
  channelChanged: () => void,
): Promise<ServerUpdates> {
  const compatibility = await client.server.updateCompatibility.query()
  const controller = createController(compatibility)
  let stop: () => void = () => undefined
  const started = new Promise<void>((resolve, reject) => {
    let last: string | null = null
    const subscription = client.server.onPublicUpdateChannel.subscribe(undefined, {
      onData: (channel) => {
        if (last === null) {
          last = channel
          controller.start(channel).then(resolve, reject)
          return
        }
        // A reconnect subscribes again and the server resends the current
        // channel; only a different channel is a change.
        if (channel === last) return
        last = channel
        channelChanged()
        controller.selectedChannelChanged(channel)
      },
      onError: (error) => {
        console.warn(`[pi-lab] update channel updates stopped: ${String(error)}`)
        reject(error)
      },
    })
    stop = () => subscription.unsubscribe()
  })
  await started
  return { controller, stop: () => stop() }
}
