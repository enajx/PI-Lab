import { useEffect, useState } from "react"
import { ScrollView, StyleSheet, Text } from "react-native"
import { type CheckParams, runCheck } from "./check"

/**
 * The collector that run-check.mjs starts on the Mac (the simulator reaches the
 * Mac's 127.0.0.1). A fixed address, built into the app; it gives the server
 * URL, the token and the session at launch. A `pilabcheck://` deep link was
 * tried first: `simctl openurl` shows an "Open in ...?" prompt that needs a tap.
 */
const COLLECTOR = "http://127.0.0.1:47913"

/** Ask the collector for the check's parameters until it answers. */
async function fetchParams(log: (line: string) => void): Promise<CheckParams> {
  for (;;) {
    const response = await fetch(`${COLLECTOR}/config`).catch(() => null)
    if (response?.ok) return { ...((await response.json()) as CheckParams), collector: COLLECTOR }
    if (response) log(`collector /config: HTTP ${response.status}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/** Runs the reconnect check once per launch and shows its log. */
export default function App() {
  const [lines, setLines] = useState<string[]>([`waiting for ${COLLECTOR}`])

  useEffect(() => {
    const log = (line: string) => setLines((previous) => [...previous, line])
    void fetchParams(log)
      .then((params) => {
        log(`check for session ${params.sessionId}`)
        return runCheck(params, log)
      })
      .catch((error: unknown) => log(`check failed: ${String(error)}`))
  }, [])

  return (
    <ScrollView style={styles.container}>
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: an append-only log.
        <Text key={index} style={styles.line}>
          {line}
        </Text>
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff", paddingTop: 60, paddingHorizontal: 12 },
  line: { fontFamily: "Menlo", fontSize: 11 },
})
