import { Pressable, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { colors } from "../theme"

/** The floating footer: a rounded bar with the two tabs, and the round lab manager button. */
export function Footer({
  page,
  onTab,
  onLabManager,
}: {
  page: number
  onTab: (page: number) => void
  onLabManager: () => void
}) {
  const insets = useSafeAreaInsets()
  const tab = (index: number, label: string) => (
    <Pressable
      key={label}
      style={[styles.tab, page === index && styles.tabActive]}
      onPress={() => onTab(index)}
      android_ripple={{ color: colors.cardPressed, borderless: false }}
      testID={`tab-${label.toLowerCase()}`}
    >
      <Text style={[styles.tabText, page === index && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  )
  return (
    <View style={[styles.wrap, { bottom: insets.bottom + 12 }]} pointerEvents="box-none">
      <View style={styles.bar}>
        {tab(0, "Inbox")}
        {tab(1, "Projects")}
      </View>
      <Pressable
        style={({ pressed }) => [styles.round, pressed && { backgroundColor: colors.cardPressed }]}
        onPress={onLabManager}
        testID="lab-manager"
      >
        <Text style={styles.roundText}>✦</Text>
      </Pressable>
    </View>
  )
}

const shadow = {
  shadowColor: "#000",
  shadowOpacity: 0.4,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 4 },
  elevation: 10,
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 16,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  bar: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: colors.footer,
    borderRadius: 30,
    padding: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: "hidden",
    ...shadow,
  },
  tab: {
    flex: 1,
    height: 46,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    overflow: "hidden",
  },
  tabActive: { backgroundColor: colors.cardPressed },
  tabText: { color: colors.muted, fontSize: 15, fontWeight: "500" },
  tabTextActive: { color: colors.text },
  round: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.footer,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    ...shadow,
  },
  roundText: { color: colors.text, fontSize: 20 },
})
