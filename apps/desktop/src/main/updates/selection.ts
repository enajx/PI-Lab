import type { PublicUpdateChannel } from "./release"

const listeners = new Set<(channel: PublicUpdateChannel) => void>()

/** Subscribe after full runtime boot to changes in the public update channel. */
export function onPublicUpdateChannelChanged(
  listener: (channel: PublicUpdateChannel) => void,
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Tell the running updater that a new channel was persisted. */
export function publishPublicUpdateChannelChanged(channel: PublicUpdateChannel): void {
  for (const listener of listeners) listener(channel)
}
