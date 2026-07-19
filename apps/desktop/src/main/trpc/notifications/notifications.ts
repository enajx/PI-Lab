import { observable } from "@trpc/server/observable"
import {
  type NotificationActivation,
  type NotificationDeliveryError,
  type NotificationSoundEvent,
  notificationActivationSchema,
  notificationDeliveryErrorSchema,
  notificationSoundEventSchema,
} from "../../notifications"
import { publicProcedure, router } from "../trpc"

export const notificationsRouter = router({
  onActivation: publicProcedure.subscription(({ ctx }) =>
    observable<NotificationActivation>((emit) =>
      ctx.notifications.activations.subscribe((event) =>
        emit.next(notificationActivationSchema.parse(event)),
      ),
    ),
  ),
  onSound: publicProcedure.subscription(({ ctx }) =>
    observable<NotificationSoundEvent>((emit) =>
      ctx.notifications.sounds.subscribe((event) =>
        emit.next(notificationSoundEventSchema.parse(event)),
      ),
    ),
  ),
  onDeliveryError: publicProcedure.subscription(({ ctx }) =>
    observable<NotificationDeliveryError>((emit) =>
      ctx.notifications.errors.subscribe((event) =>
        emit.next(notificationDeliveryErrorSchema.parse(event)),
      ),
    ),
  ),
})
