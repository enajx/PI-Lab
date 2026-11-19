import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native"
import { AgentIcon } from "../components/Icons"
import { useData } from "../data"
import type { InboxItem } from "../logic/inbox"
import type { ScreenProps } from "../navigation"
import { colors, FOOTER_SPACE } from "../theme"
import { ago } from "../time"
import { useServerQuery } from "../useServerQuery"

/** Agents waiting for an answer first, then notices that an agent has finished. */
export function InboxPage({ navigation }: { navigation: ScreenProps<"Home">["navigation"] }) {
  const { inbox, items } = useData()
  const projects = useServerQuery("projects", (client) => client.projects.list.query())
  const projectName = (item: InboxItem) =>
    projects.data?.find((project) => project.id === item.projectId)?.name ?? null
  const open = (item: InboxItem) => {
    if (!item.sessionId) return
    navigation.navigate("Session", {
      sessionId: item.sessionId,
      title: projectName(item) ?? item.title,
      requestId: item.canAnswer ? item.id : null,
    })
  }
  const error = inbox.error()
  return (
    <FlatList
      data={items}
      keyExtractor={(item) => item.id}
      contentContainerStyle={{ paddingBottom: FOOTER_SPACE, paddingTop: 4 }}
      ListHeaderComponent={
        <>
          {inbox.loading() ? (
            <ActivityIndicator color={colors.muted} style={{ margin: 12 }} />
          ) : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </>
      }
      ListEmptyComponent={
        inbox.loading() ? undefined : (
          <Text style={styles.empty}>Nothing needs your attention.</Text>
        )
      }
      renderItem={({ item }) => (
        <Pressable
          onPress={() => open(item)}
          android_ripple={{ color: colors.cardPressed }}
          style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.cardPressed }]}
          testID={`inbox-${item.id}`}
        >
          <View style={styles.icon}>
            {item.sessionId ? (
              <AgentIcon color={item.canAnswer ? colors.waiting : colors.muted} size={18} />
            ) : (
              <View
                style={[
                  styles.dot,
                  { backgroundColor: item.canAnswer ? colors.waiting : colors.faint },
                ]}
              />
            )}
          </View>
          <View style={styles.rowText}>
            <View style={styles.rowTop}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={styles.time}>{ago(item.at)}</Text>
            </View>
            {projectName(item) ? <Text style={styles.project}>{projectName(item)}</Text> : null}
            <Text style={styles.body} numberOfLines={2}>
              {item.body}
            </Text>
            {item.canAnswer ? (
              <View style={styles.tag}>
                <Text style={styles.tagText}>Needs input</Text>
              </View>
            ) : null}
          </View>
        </Pressable>
      )}
    />
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  icon: { width: 18, alignItems: "center", marginTop: 1, marginRight: 12 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  rowText: { flex: 1 },
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rowTitle: { color: colors.text, fontSize: 16, fontWeight: "500", flex: 1, marginRight: 8 },
  time: { color: colors.faint, fontSize: 13 },
  project: { color: colors.text, fontSize: 14, marginTop: 3 },
  body: { color: colors.muted, fontSize: 14, marginTop: 3, lineHeight: 19 },
  tag: {
    alignSelf: "flex-start",
    marginTop: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: "rgba(226, 160, 63, 0.15)",
  },
  tagText: { color: colors.waiting, fontSize: 12, fontWeight: "600" },
  empty: { color: colors.muted, fontSize: 15, textAlign: "center", marginTop: 60 },
  error: { color: colors.danger, fontSize: 14, marginHorizontal: 20, marginVertical: 8 },
})
