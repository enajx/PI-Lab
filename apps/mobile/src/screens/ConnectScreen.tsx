// Stand-in for pairing (not designed yet): the server address and device
// token, typed or pasted as one connect link, kept in the system secure storage.

import { useState } from "react"
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { useConnection } from "../connection"
import { parseConnectLink } from "../logic/address"
import { colors } from "../theme"

export function ConnectScreen() {
  const { phase, submitLogin } = useConnection()
  const stored = phase.kind === "login" ? phase.login : null
  const [link, setLink] = useState("")
  const [address, setAddress] = useState(stored?.address ?? "")
  const [token, setToken] = useState(stored?.token ?? "")
  const [error, setError] = useState<string | null>(phase.kind === "login" ? phase.error : null)

  const onLink = (text: string) => {
    setLink(text)
    const parsed = parseConnectLink(text)
    if (parsed) {
      setAddress(parsed.address)
      setToken(parsed.token)
      setError(null)
    } else if (text.trim().length > 0) {
      setError("This is not a connect link (pilab://connect?...).")
    } else {
      setError(null)
    }
  }

  const connect = () => {
    const login = { address: address.trim(), token: token.trim() }
    if (!login.address || !login.token) {
      setError("Enter the server address and the device token.")
      return
    }
    // submitLogin rejects with a readable message for a bad address (endpointFor).
    void submitLogin(login).catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    )
  }

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView behavior="padding" style={styles.screen}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Connect to PI Lab</Text>
          <Text style={styles.hint}>
            Paste the connect link printed on the Mac, or enter the address and the token.
          </Text>

          <Text style={styles.label}>Connect link</Text>
          <TextInput
            style={styles.input}
            value={link}
            onChangeText={onLink}
            placeholder="pilab://connect?address=...&token=..."
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            testID="connect-link"
          />

          <Text style={styles.label}>Server address</Text>
          <TextInput
            style={styles.input}
            value={address}
            onChangeText={setAddress}
            placeholder="https://your-mac.tailnet.ts.net"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            testID="connect-address"
          />

          <Text style={styles.label}>Device token</Text>
          <TextInput
            style={styles.input}
            value={token}
            onChangeText={setToken}
            placeholder="token"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            testID="connect-token"
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            style={({ pressed }) => [styles.button, pressed && { opacity: 0.8 }]}
            onPress={connect}
            testID="connect-button"
          >
            <Text style={styles.buttonText}>Connect</Text>
          </Pressable>
          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, paddingTop: 48 },
  title: { color: colors.text, fontSize: 28, fontWeight: "700" },
  hint: { color: colors.muted, fontSize: 15, marginTop: 8, marginBottom: 24, lineHeight: 21 },
  label: { color: colors.muted, fontSize: 13, marginTop: 16, marginBottom: 6 },
  input: {
    backgroundColor: colors.card,
    color: colors.text,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  error: { color: colors.danger, fontSize: 14, marginTop: 16 },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 28,
  },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
})
