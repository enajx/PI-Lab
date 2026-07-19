import type {
  NotificationActivation,
  NotificationDeliveryError,
  NotificationSoundEvent,
} from "./types"

export type BrokerListener<T> = (event: T) => void

/** App-lifetime fanout used by typed tRPC subscriptions. */
export class EventBroker<T> {
  private readonly listeners = new Set<BrokerListener<T>>()
  private readonly pending: T[] = []

  publish(event: T): void {
    if (this.listeners.size === 0) {
      this.pending.push(event)
      if (this.pending.length > 32) this.pending.shift()
      return
    }
    for (const listener of this.listeners) listener(event)
  }

  subscribe(listener: BrokerListener<T>): () => void {
    this.listeners.add(listener)
    for (const event of this.pending.splice(0)) listener(event)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

export interface NotificationBrokers {
  activations: EventBroker<NotificationActivation>
  sounds: EventBroker<NotificationSoundEvent>
  errors: EventBroker<NotificationDeliveryError>
}

export function createNotificationBrokers(): NotificationBrokers {
  return {
    activations: new EventBroker<NotificationActivation>(),
    sounds: new EventBroker<NotificationSoundEvent>(),
    errors: new EventBroker<NotificationDeliveryError>(),
  }
}
