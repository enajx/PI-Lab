import { DarkTheme, NavigationContainer } from "@react-navigation/native"
import { createNativeStackNavigator } from "@react-navigation/native-stack"
import { StatusBar } from "expo-status-bar"
import { useEffect, useState } from "react"
import { ActivityIndicator, Linking, View } from "react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { ConnectionProvider, useConnection } from "./src/connection"
import { DataProvider } from "./src/data"
import type { RootStack } from "./src/navigation"
import { ConnectScreen } from "./src/screens/ConnectScreen"
import {
  type BenchParams,
  DictationBenchScreen,
  parseBenchLink,
} from "./src/screens/DictationBenchScreen"
import { HomeScreen } from "./src/screens/HomeScreen"
import { LabManagerScreen } from "./src/screens/LabManagerScreen"
import { ProjectScreen } from "./src/screens/ProjectScreen"
import { SessionScreen } from "./src/screens/SessionScreen"
import { colors } from "./src/theme"

const Stack = createNativeStackNavigator<RootStack>()

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.background,
    card: colors.background,
    text: colors.text,
    border: colors.border,
    primary: colors.accent,
  },
}

/** The dictation benchmark's parameters when the app was opened with its link (debug only). */
function useBenchLink(): BenchParams | null {
  const [bench, setBench] = useState<BenchParams | null>(null)
  useEffect(() => {
    void Linking.getInitialURL().then((url) => setBench(parseBenchLink(url ?? null)))
    const listener = Linking.addEventListener("url", ({ url }) => {
      const params = parseBenchLink(url)
      if (params) setBench(params)
    })
    return () => listener.remove()
  }, [])
  return bench
}

function Root() {
  const { phase } = useConnection()
  const bench = useBenchLink()
  if (phase.kind === "starting") {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, justifyContent: "center" }}>
        <ActivityIndicator color={colors.muted} />
      </View>
    )
  }
  if (phase.kind === "login") return <ConnectScreen />
  if (bench) return <DictationBenchScreen params={bench} />
  return (
    <DataProvider>
      <NavigationContainer theme={theme}>
        <Stack.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.text,
            headerShadowVisible: false,
            contentStyle: { backgroundColor: colors.background },
            animation: "default",
          }}
        >
          <Stack.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Project" component={ProjectScreen} options={{ title: "" }} />
          <Stack.Screen name="Session" component={SessionScreen} options={{ title: "" }} />
          <Stack.Screen
            name="LabManager"
            component={LabManagerScreen}
            options={{
              presentation: "formSheet",
              headerShown: false,
              sheetAllowedDetents: [0.35],
              sheetGrabberVisible: true,
              sheetCornerRadius: 24,
              contentStyle: { backgroundColor: colors.card },
            }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </DataProvider>
  )
}

/** The PI Lab phone app (test build). */
export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <ConnectionProvider>
        <Root />
      </ConnectionProvider>
    </SafeAreaProvider>
  )
}
