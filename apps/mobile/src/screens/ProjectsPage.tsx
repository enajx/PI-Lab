import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native"
import type { ScreenProps } from "../navigation"
import { colors, FOOTER_SPACE } from "../theme"
import { useServerQuery } from "../useServerQuery"

/** The projects (hidden ones left out); tapping one opens the project view. */
export function ProjectsPage({ navigation }: { navigation: ScreenProps<"Home">["navigation"] }) {
  const projects = useServerQuery("projects", (client) => client.projects.list.query())
  const shown = (projects.data ?? []).filter((project) => project.archivedAt === null)
  return (
    <FlatList
      data={shown}
      keyExtractor={(project) => project.id}
      contentContainerStyle={{ paddingBottom: FOOTER_SPACE, paddingTop: 4 }}
      ListHeaderComponent={
        <>
          {projects.data === null && !projects.error ? (
            <ActivityIndicator color={colors.muted} style={{ margin: 12 }} />
          ) : null}
          {projects.error ? <Text style={styles.error}>{projects.error}</Text> : null}
        </>
      }
      ListEmptyComponent={
        projects.data === null ? undefined : <Text style={styles.empty}>No projects yet.</Text>
      }
      renderItem={({ item }) => (
        <Pressable
          onPress={() => navigation.navigate("Project", { projectId: item.id, name: item.name })}
          android_ripple={{ color: colors.cardPressed }}
          style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.cardPressed }]}
          testID={`project-${item.id}`}
        >
          <View style={[styles.mark, { backgroundColor: item.color ?? colors.accent }]}>
            <Text style={styles.markText}>{item.name.slice(0, 1).toUpperCase()}</Text>
          </View>
          <Text style={styles.name} numberOfLines={1}>
            {item.name}
          </Text>
        </Pressable>
      )}
    />
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  mark: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  markText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  name: { color: colors.text, fontSize: 16, fontWeight: "500", flex: 1 },
  empty: { color: colors.muted, fontSize: 15, textAlign: "center", marginTop: 60 },
  error: { color: colors.danger, fontSize: 14, marginHorizontal: 20, marginVertical: 8 },
})
