import type { NativeStackScreenProps } from "@react-navigation/native-stack"

/** The app's screens and their parameters. */
export type RootStack = {
  Home: undefined
  Project: { projectId: string; name: string }
  /** `requestId` when opened from a waiting Inbox item: the reply then answers that request. */
  Session: { sessionId: string; title: string; requestId: string | null }
  LabManager: undefined
}

export type ScreenProps<Name extends keyof RootStack> = NativeStackScreenProps<RootStack, Name>
