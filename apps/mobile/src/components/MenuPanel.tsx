// The agent's menu as buttons (read by the server from the terminal screen):
// the question, one button per option, and for a multi-select question the
// ticks the agent shows and a Confirm button. A free-text option asks for
// text in the reply box below.

import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import type { MenuAction, TerminalMenu } from "../logic/menu"
import { colors } from "../theme"

export function MenuPanel({
  menu,
  busy,
  onAction,
  onFreeText,
}: {
  menu: TerminalMenu
  /** A choice is on its way: the buttons wait. */
  busy: boolean
  onAction: (action: MenuAction) => void
  /** A single-choice free-text option was tapped: the reply box takes the text. */
  onFreeText: () => void
}) {
  return (
    <View style={styles.panel} testID="menu-panel">
      {menu.tabs ? (
        <View style={styles.tabs}>
          {menu.tabs.map((tab) => (
            <Text key={tab.label} style={[styles.tab, tab.answered && styles.tabAnswered]}>
              {tab.answered ? "✓ " : ""}
              {tab.label}
            </Text>
          ))}
        </View>
      ) : null}
      {menu.question ? (
        <Text style={styles.question} numberOfLines={8}>
          {menu.question}
        </Text>
      ) : null}
      <ScrollView style={styles.options} contentContainerStyle={{ gap: 8 }}>
        {menu.options.map((option) => {
          const tap = () => {
            if (option.freeText && !menu.multiSelect) onFreeText()
            else onAction({ kind: "choose", option: option.key })
          }
          return (
            <Pressable
              key={option.key}
              onPress={tap}
              disabled={busy}
              style={({ pressed }) => [
                styles.option,
                option.cursor && styles.optionCursor,
                pressed && { backgroundColor: colors.cardPressed },
                busy && { opacity: 0.5 },
              ]}
              testID={`menu-option-${option.key}`}
            >
              {option.checked !== null ? (
                <View style={[styles.box, option.checked && styles.boxChecked]}>
                  {option.checked ? <Text style={styles.tick}>✓</Text> : null}
                </View>
              ) : null}
              <View style={{ flex: 1 }}>
                <Text style={[styles.label, option.freeText && styles.freeText]}>
                  {option.label}
                </Text>
                {option.detail ? <Text style={styles.detail}>{option.detail}</Text> : null}
                {option.freeText ? (
                  <Text style={styles.detail}>Type your answer in the box below.</Text>
                ) : null}
              </View>
            </Pressable>
          )
        })}
      </ScrollView>
      {menu.multiSelect ? (
        <Pressable
          onPress={() => onAction({ kind: "submit" })}
          disabled={busy}
          style={({ pressed }) => [styles.confirm, (pressed || busy) && { opacity: 0.7 }]}
          testID="menu-confirm"
        >
          <Text style={styles.confirmText}>Confirm</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    marginHorizontal: 12,
    marginTop: 12,
    padding: 12,
    gap: 10,
  },
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  tab: {
    color: colors.muted,
    fontSize: 12,
    backgroundColor: colors.background,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: "hidden",
  },
  tabAnswered: { color: colors.working },
  question: { color: colors.text, fontSize: 15, fontWeight: "600", lineHeight: 21 },
  options: { maxHeight: 300 },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.background,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  optionCursor: { borderColor: colors.accent },
  label: { color: colors.text, fontSize: 15 },
  freeText: { color: colors.muted, fontStyle: "italic" },
  detail: { color: colors.muted, fontSize: 13, marginTop: 2, lineHeight: 18 },
  box: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: colors.faint,
    alignItems: "center",
    justifyContent: "center",
  },
  boxChecked: { backgroundColor: colors.accent, borderColor: colors.accent },
  tick: { color: "#fff", fontSize: 13, fontWeight: "700" },
  confirm: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  confirmText: { color: "#fff", fontSize: 15, fontWeight: "600" },
})
