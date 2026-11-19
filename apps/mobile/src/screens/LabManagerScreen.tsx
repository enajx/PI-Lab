import { StyleSheet, Text, View } from "react-native"
import { colors } from "../theme"

/** The round footer button's sheet: the lab manager is a later feature. */
export function LabManagerScreen() {
  return (
    <View style={styles.sheet}>
      <Text style={styles.title}>Lab manager</Text>
      <Text style={styles.body}>Not available yet.</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  sheet: { flex: 1, padding: 24, paddingTop: 32, backgroundColor: colors.card },
  title: { color: colors.text, fontSize: 20, fontWeight: "600" },
  body: { color: colors.muted, fontSize: 15, marginTop: 8 },
})
