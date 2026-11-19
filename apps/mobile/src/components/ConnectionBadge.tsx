import { Pressable, StyleSheet, Text, View } from "react-native"
import { useConnection, useConnectionState } from "../connection"
import { colors } from "../theme"

const LABELS: Record<string, { text: string; color: string }> = {
  connected: { text: "Connected", color: colors.working },
  reconnecting: { text: "Reconnecting", color: colors.waiting },
  disconnected: { text: "Disconnected", color: colors.danger },
  offline: { text: "Connecting", color: colors.faint },
}

/** The small connection state indicator; tapping it opens the connect screen. */
export function ConnectionBadge() {
  const state = useConnectionState()
  const { openLogin } = useConnection()
  const label = LABELS[state] ?? { text: state, color: colors.faint }
  return (
    <Pressable onLongPress={openLogin} onPress={openLogin} hitSlop={8} testID="connection-badge">
      <View style={styles.badge}>
        <View style={[styles.dot, { backgroundColor: label.color }]} />
        <Text style={styles.text}>{label.text}</Text>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: colors.card,
  },
  dot: { width: 7, height: 7, borderRadius: 4, marginRight: 6 },
  text: { color: colors.muted, fontSize: 12 },
})
