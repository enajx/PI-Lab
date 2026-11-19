import * as Crypto from "expo-crypto"
import * as SecureStore from "expo-secure-store"
import type { ServerLogin } from "./logic/address"

const LOGIN_KEY = "pilab.login"
const CLIENT_ID_KEY = "pilab.clientId"

/** The stored server address and device token (system secure storage), or null. */
export async function readLogin(): Promise<ServerLogin | null> {
  const text = await SecureStore.getItemAsync(LOGIN_KEY)
  return text === null ? null : (JSON.parse(text) as ServerLogin)
}

export async function writeLogin(login: ServerLogin): Promise<void> {
  await SecureStore.setItemAsync(LOGIN_KEY, JSON.stringify(login))
}

/** This install's client id for `terminal.sendMessage`, made once. */
export async function readClientId(): Promise<string> {
  const stored = await SecureStore.getItemAsync(CLIENT_ID_KEY)
  if (stored !== null) return stored
  const id = `phone-${Crypto.randomUUID()}`
  await SecureStore.setItemAsync(CLIENT_ID_KEY, id)
  return id
}

export function newId(): string {
  return Crypto.randomUUID()
}
