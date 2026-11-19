// Lucide icons (https://lucide.dev, ISC licence), the icon set of the desktop
// app. Each icon is imported on its own, so the bundle holds only these.

import Bot from "lucide-react-native/icons/bot"
import User from "lucide-react-native/icons/user"
import UserExclamationPoint from "lucide-react-native/icons/user-exclamation-point"
import { colors } from "../theme"

/** The lab manager's icon: `user`, or `user-exclamation-point` when the lab manager needs something. */
export function LabManagerIcon({
  needsAttention,
  size,
}: {
  needsAttention: boolean
  size: number
}) {
  const Icon = needsAttention ? UserExclamationPoint : User
  return <Icon size={size} color={needsAttention ? colors.waiting : colors.text} strokeWidth={2} />
}

/** An agent (Lucide `bot`, as the desktop app shows agents), tinted with its status colour. */
export function AgentIcon({ color, size }: { color: string; size: number }) {
  return <Bot size={size} color={color} strokeWidth={2} />
}
