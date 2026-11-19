import { useEffect, useRef, useState } from "react"
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { useConnection } from "../connection"
import { useData } from "../data"
import type { ScreenProps } from "../navigation"
import { newId } from "../storage"
import { colors } from "../theme"
import { useServerQuery } from "../useServerQuery"

/**
 * One project: its live agents and their status (tap opens the session), a box
 * to start the project's agent with a message, and progress of its TODO file.
 */
export function ProjectScreen({ route, navigation }: ScreenProps<"Project">) {
  const { projectId, name } = route.params
  useEffect(() => navigation.setOptions({ title: name }), [navigation, name])
  const { agents } = useData()
  const { connection } = useConnection()
  const catalog = useServerQuery("agents", (client) => client.agents.list.query())
  const chosen = useServerQuery(`choice:${projectId}`, async (client) => {
    const choice = await client.agents.projectChoice.query({ projectId })
    if (choice.agentId) return { agentId: choice.agentId }
    return { agentId: (await client.settings.get.query()).agents.defaultAgentId }
  })
  const agentId = chosen.data?.agentId ?? null
  const tasks = useServerQuery("tasks", (client) => client.science.tasks.list.query())

  const label = (agentId: string) =>
    catalog.data?.find((agent) => agent.id === agentId)?.label ?? agentId
  const live = (agents ?? []).filter((agent) => agent.projectId === projectId)

  // Start an agent: one launch ID per message, kept until the start worked.
  const [prompt, setPrompt] = useState("")
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const launch = useRef<{ id: string; prompt: string } | null>(null)
  const start = () => {
    if (!connection || !agentId || starting) return
    if (launch.current?.prompt !== prompt) launch.current = { id: newId(), prompt }
    const launchId = launch.current.id
    setStarting(true)
    setStartError(null)
    connection.client.sessions.start
      .mutate({ projectId, agentId, origin: "project", prompt, launchId })
      .then(
        (result) => {
          launch.current = null
          setPrompt("")
          navigation.navigate("Session", {
            sessionId: result.sessionId,
            title: label(agentId),
            requestId: null,
          })
        },
        (reason: unknown) =>
          setStartError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setStarting(false))
  }

  const source = tasks.data?.sources.find((entry) => entry.projectId === projectId) ?? null
  const projectTasks = (tasks.data?.tasks ?? []).filter((task) => task.projectId === projectId)
  const count = (status: string) => projectTasks.filter((task) => task.status === status).length
  const done = count("done")
  const total = projectTasks.length

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.section}>Agents</Text>
        <View style={styles.card}>
          {agents === null ? (
            <ActivityIndicator color={colors.muted} style={{ margin: 14 }} />
          ) : null}
          {agents !== null && live.length === 0 ? (
            <Text style={styles.cardEmpty}>No agent is running.</Text>
          ) : null}
          {live.map((agent, index) => (
            <Pressable
              key={agent.sessionId}
              onPress={() =>
                navigation.navigate("Session", {
                  sessionId: agent.sessionId,
                  title: label(agent.agentId),
                  requestId: null,
                })
              }
              android_ripple={{ color: colors.cardPressed }}
              style={[styles.agentRow, index > 0 && styles.divider]}
              testID={`agent-${agent.sessionId}`}
            >
              <View
                style={[
                  styles.dot,
                  {
                    backgroundColor: agent.state === "working" ? colors.working : colors.waiting,
                  },
                ]}
              />
              <Text style={styles.agentName} numberOfLines={1}>
                {label(agent.agentId)}
              </Text>
              <Text style={styles.agentState}>
                {agent.state === "working" ? "Working" : "Waiting"}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.section}>Start an agent</Text>
        <View style={styles.card}>
          <Text style={styles.agentHint}>
            {chosen.error
              ? chosen.error
              : chosen.data === null
                ? "Reading the project's agent..."
                : agentId
                  ? `Agent: ${label(agentId)}`
                  : "No agent is chosen for this project or as the default (set one on the desktop)."}
          </Text>
          <TextInput
            style={styles.input}
            value={prompt}
            onChangeText={setPrompt}
            placeholder="What should the agent do?"
            placeholderTextColor={colors.faint}
            multiline
            testID="start-prompt"
          />
          {startError ? <Text style={styles.error}>{startError}</Text> : null}
          <Pressable
            style={[styles.button, (!agentId || starting) && { opacity: 0.5 }]}
            onPress={start}
            disabled={!agentId || starting}
            testID="start-agent"
          >
            <Text style={styles.buttonText}>{starting ? "Starting..." : "Start"}</Text>
          </Pressable>
        </View>

        <Text style={styles.section}>TODO</Text>
        <View style={styles.card}>
          {tasks.data === null && !tasks.error ? (
            <ActivityIndicator color={colors.muted} style={{ margin: 14 }} />
          ) : null}
          {tasks.error ? <Text style={styles.error}>{tasks.error}</Text> : null}
          {tasks.data && source?.state !== "ready" ? (
            <Text style={styles.cardEmpty}>
              {source?.state === "ambiguous"
                ? "Several TODO files; choose one on the desktop."
                : source?.state === "error"
                  ? (source.error ?? "The TODO file could not be read.")
                  : "No TODO file."}
            </Text>
          ) : null}
          {tasks.data && source?.state === "ready" ? (
            <View style={styles.todo}>
              <Text style={styles.todoLine}>
                {done} of {total} done
              </Text>
              <View style={styles.bar}>
                <View
                  style={[styles.barFill, { width: `${total === 0 ? 0 : (done / total) * 100}%` }]}
                />
              </View>
              <Text style={styles.todoDetail}>
                {count("wip")} in progress · {count("planned")} planned · {count("backlog")} backlog
              </Text>
              <Text style={styles.todoFile}>{source.relPath}</Text>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, paddingBottom: 48 },
  section: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: "600",
    marginTop: 20,
    marginBottom: 8,
    marginLeft: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  card: { backgroundColor: colors.card, borderRadius: 14, overflow: "hidden" },
  cardEmpty: { color: colors.muted, fontSize: 15, padding: 16 },
  agentRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 12 },
  agentName: { color: colors.text, fontSize: 16, flex: 1 },
  agentState: { color: colors.muted, fontSize: 14 },
  agentHint: { color: colors.muted, fontSize: 14, paddingHorizontal: 16, paddingTop: 14 },
  input: {
    color: colors.text,
    fontSize: 16,
    marginHorizontal: 16,
    marginTop: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    minHeight: 70,
    textAlignVertical: "top",
    backgroundColor: colors.background,
    borderRadius: 10,
  },
  error: { color: colors.danger, fontSize: 14, paddingHorizontal: 16, paddingTop: 10 },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    margin: 16,
    paddingVertical: 12,
    alignItems: "center",
  },
  buttonText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  todo: { padding: 16 },
  todoLine: { color: colors.text, fontSize: 16, fontWeight: "500" },
  bar: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.border,
    marginTop: 10,
    overflow: "hidden",
  },
  barFill: { height: 6, backgroundColor: colors.working },
  todoDetail: { color: colors.muted, fontSize: 14, marginTop: 10 },
  todoFile: { color: colors.faint, fontSize: 12, marginTop: 6 },
})
