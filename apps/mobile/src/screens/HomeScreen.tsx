import { useRef, useState } from "react"
import { StyleSheet, Text, View } from "react-native"
import PagerView from "react-native-pager-view"
import { SafeAreaView } from "react-native-safe-area-context"
import { ConnectionBadge } from "../components/ConnectionBadge"
import { Footer } from "../components/Footer"
import type { ScreenProps } from "../navigation"
import { colors } from "../theme"
import { InboxPage } from "./InboxPage"
import { ProjectsPage } from "./ProjectsPage"

const TITLES = ["Inbox", "Projects"]

/** Inbox and Projects side by side: a sideways swipe or a footer tab moves between them. */
export function HomeScreen({ navigation }: ScreenProps<"Home">) {
  const pager = useRef<PagerView>(null)
  const [page, setPage] = useState(0)
  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>{TITLES[page]}</Text>
        <ConnectionBadge />
      </View>
      <PagerView
        ref={pager}
        style={styles.pager}
        initialPage={0}
        onPageSelected={(event) => setPage(event.nativeEvent.position)}
      >
        <View key="inbox" style={styles.page}>
          <InboxPage navigation={navigation} />
        </View>
        <View key="projects" style={styles.page}>
          <ProjectsPage navigation={navigation} />
        </View>
      </PagerView>
      <Footer
        page={page}
        onTab={(next) => {
          pager.current?.setPage(next)
          setPage(next)
        }}
        onLabManager={() => navigation.navigate("LabManager")}
      />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  title: { color: colors.text, fontSize: 30, fontWeight: "700" },
  pager: { flex: 1 },
  page: { flex: 1 },
})
