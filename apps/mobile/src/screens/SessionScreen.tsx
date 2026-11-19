// One session: its current terminal screen as read-only plain text (no
// scroll back), read again every second with `terminal.screenText` while the
// screen is open, and a reply box. Opened from a waiting Inbox item, the reply
// answers that request (`server.answerRequest`); otherwise it is sent as a
// whole message with `terminal.sendMessage`.

import { useHeaderHeight } from "@react-navigation/elements"
import { useEffect, useState } from "react"
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useConnection } from "../connection"
import { useData } from "../data"
import { answerInboxItem } from "../logic/answer"
import { MessageOutbox } from "../logic/outbox"
import { sessionEnded } from "../logic/sessionEnded"
import type { ScreenProps } from "../navigation"
import { newId, readClientId } from "../storage"
import { colors, mono } from "../theme"

/** The server capability that announces `terminal.screenText`. */
const SCREEN_TEXT_CAPABILITY = "screen-text"
const REFRESH_MS = 1000

/** One outbox per session for the app's lifetime, so a resend after reopening the screen keeps its message ID. */
const outboxes = new Map<string, MessageOutbox>()
function outboxFor(sessionId: string): MessageOutbox {
  let outbox = outboxes.get(sessionId)
  if (!outbox) {
    outbox = new MessageOutbox(newId)
    outboxes.set(sessionId, outbox)
  }
  return outbox
}

export function SessionScreen({ route, navigation }: ScreenProps<"Session">) {
  const { sessionId, title, requestId } = route.params
  useEffect(() => navigation.setOptions({ title }), [navigation, title])
  const { connection, capabilities } = useConnection()
  const { inbox } = useData()
  const headerHeight = useHeaderHeight()
  const insets = useSafeAreaInsets()
  // The bottom inset is for the gesture bar; it is covered while the keyboard shows.
  const [keyboard, setKeyboard] = useState(false)
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", () => setKeyboard(true))
    const hidden = Keyboard.addListener("keyboardDidHide", () => setKeyboard(false))
    return () => {
      shown.remove()
      hidden.remove()
    }
  }, [])

  const [screen, setScreen] = useState<string | null>(null)
  const [screenError, setScreenError] = useState<string | null>(null)
  // The agent exited: the last text stays, the reply box is off, reading stops.
  const [ended, setEnded] = useState(false)
  const supported = capabilities === null ? null : capabilities.includes(SCREEN_TEXT_CAPABILITY)

  useEffect(() => {
    if (!connection || supported !== true || ended) return
    let current = true
    const read = () =>
      connection.client.terminal.screenText.query({ sessionId }).then(
        (result) => {
          if (!current) return
          setScreen(result.text)
          setScreenError(null)
        },
        (reason: unknown) => {
          if (!current) return
          const message = reason instanceof Error ? reason.message : String(reason)
          if (sessionEnded(message, sessionId)) setEnded(true)
          else setScreenError(message)
        },
      )
    void read()
    const timer = setInterval(read, REFRESH_MS)
    return () => {
      current = false
      clearInterval(timer)
    }
  }, [connection, sessionId, supported, ended])

  // Opened from a waiting item, the reply answers that request until the server
  // settles it (accepted or already answered), even when the item has left the
  // Inbox meanwhile: the server then says who answered, and the answer is never
  // typed into the terminal as a plain message.
  const [settled, setSettled] = useState(false)
  const pending = requestId !== null && !settled
  const outbox = outboxFor(sessionId)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  const send = async () => {
    const text = draft
    if (!connection || sending || ended || text.trim().length === 0) return
    setSending(true)
    setSendError(null)
    const sent =
      pending && requestId !== null
        ? answerInboxItem(
            { answerRequest: (input) => connection.client.server.answerRequest.mutate(input) },
            inbox,
            requestId,
            text,
          ).then((result) => {
            setSettled(true)
            if (result.notice) Alert.alert("Already answered", result.notice)
            // Cleared either way, so the answer text is never sent again as a plain message.
            return true
          })
        : readClientId().then((clientId) =>
            outbox
              .send(text, (message) =>
                connection.client.terminal.sendMessage
                  .mutate({ sessionId, clientId, ...message })
                  .then(() => undefined),
              )
              .then(() => true),
          )
    await sent.then(
      (written) => {
        if (written) setDraft("")
      },
      (reason: unknown) =>
        setSendError(
          `Not sent: ${reason instanceof Error ? reason.message : String(reason)}. Tap again to send it.`,
        ),
    )
    setSending(false)
  }

  return (
    <KeyboardAvoidingView
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
      style={styles.screen}
    >
      <ScrollView style={styles.terminal} contentContainerStyle={{ padding: 12 }}>
        {supported === false ? (
          <Text style={styles.notice}>
            This server cannot show a session's screen as text yet (it does not have the
            "screen-text" capability). Update PI Lab on the computer.
          </Text>
        ) : null}
        {ended ? <Text style={styles.ended}>This session has ended.</Text> : null}
        {screenError && !ended ? <Text style={styles.error}>{screenError}</Text> : null}
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text style={styles.screenText} selectable testID="screen-text">
            {screen ?? ""}
          </Text>
        </ScrollView>
      </ScrollView>
      <View
        style={[styles.composer, { paddingBottom: keyboard ? 10 : Math.max(insets.bottom, 10) }]}
      >
        {sendError ? <Text style={styles.error}>{sendError}</Text> : null}
        <View style={styles.row}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={
              ended ? "The session has ended" : pending ? "Answer the agent" : "Message the agent"
            }
            placeholderTextColor={colors.faint}
            multiline
            editable={!ended}
            testID="reply-input"
          />
          <Pressable
            style={[
              styles.send,
              (sending || ended || draft.trim().length === 0) && { opacity: 0.5 },
            ]}
            onPress={send}
            disabled={sending || ended || draft.trim().length === 0}
            testID="reply-send"
          >
            <Text style={styles.sendText}>{pending ? "Answer" : "Send"}</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  terminal: { flex: 1, backgroundColor: "#0A0A0B" },
  screenText: { color: colors.text, fontFamily: mono, fontSize: 11, lineHeight: 15 },
  ended: { color: colors.muted, fontSize: 14, marginBottom: 12 },
  notice: { color: colors.waiting, fontSize: 14, marginBottom: 12, lineHeight: 20 },
  error: { color: colors.danger, fontSize: 13, marginBottom: 8 },
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    backgroundColor: colors.card,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    maxHeight: 140,
  },
  send: {
    backgroundColor: colors.accent,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  sendText: { color: "#fff", fontSize: 15, fontWeight: "600" },
})
