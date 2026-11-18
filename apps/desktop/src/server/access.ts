import { randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Local access files in the data folder. `server-token` is the local device
 * token, readable only by the owner, so the desktop app on the same machine
 * connects with no setup. `server.json` tells clients where the server listens.
 */
export const TOKEN_FILE = "server-token"
export const DISCOVERY_FILE = "server.json"

/** Header carrying the device token on plain HTTP requests. */
export const TOKEN_HEADER = "x-pi-lab-token"

/** Unauthenticated path that answers only the server's random id. */
export const IDENTITY_PATH = "/identity"

/** What the server writes to `server.json` once it listens. */
export interface ServerDiscovery {
  port: number
  pid: number
  build: string
  /** Random id, new on every server start; `GET /identity` answers it. */
  serverId: string
}

/** Write a file with owner-only permissions, atomically (temp file and rename). */
function writeOwnerOnly(path: string, content: string): void {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, content, { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, path)
}

/** Refuse a file that group or other users can read or write. */
function assertOwnerOnly(path: string): void {
  const mode = statSync(path).mode & 0o777
  if ((mode & 0o077) !== 0) {
    throw new Error(`${path} is readable by other users (mode ${mode.toString(8)}); expected 600`)
  }
}

/** Read the local device token, creating it on first start. */
export function ensureLocalToken(dataDir: string): string {
  const path = join(dataDir, TOKEN_FILE)
  if (!existsSync(path)) writeOwnerOnly(path, `${randomBytes(32).toString("base64url")}\n`)
  assertOwnerOnly(path)
  const token = readFileSync(path, "utf8").trim()
  if (token.length < 32) throw new Error(`${path} does not hold a valid token`)
  return token
}

/** Read the local device token written by the server; null before its first start. */
export function readLocalToken(dataDir: string): string | null {
  const path = join(dataDir, TOKEN_FILE)
  if (!existsSync(path)) return null
  assertOwnerOnly(path)
  return readFileSync(path, "utf8").trim()
}

/** Compare a presented token with the expected one in constant time. */
export function tokenMatches(expected: string, presented: string | null): boolean {
  if (!presented) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function writeDiscovery(dataDir: string, discovery: ServerDiscovery): void {
  writeOwnerOnly(join(dataDir, DISCOVERY_FILE), `${JSON.stringify(discovery)}\n`)
}

/** The discovery file, or null when no server has written one. */
export function readDiscovery(dataDir: string): ServerDiscovery | null {
  const path = join(dataDir, DISCOVERY_FILE)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, "utf8")) as ServerDiscovery
}

/** A new random server id for one server start. */
export function newServerId(): string {
  return randomBytes(16).toString("base64url")
}

/**
 * True when the process listening on `port` answers `GET /identity` with
 * `serverId` (from the owner-only `server.json`). Clients call this before
 * they send the token, so a stale port taken by another process never gets it.
 * Redirects are refused.
 */
export async function isServerIdentity(port: number, serverId: string): Promise<boolean> {
  const response = await fetch(`http://127.0.0.1:${port}${IDENTITY_PATH}`, {
    redirect: "error",
    signal: AbortSignal.timeout(2_000),
  }).catch(() => null)
  if (!response?.ok) return false
  const body = (await response.json().catch(() => null)) as { serverId?: unknown } | null
  return body?.serverId === serverId
}

/**
 * True when the PI Lab server named by `discovery` is the process on its port
 * and accepts `token`. The token is sent only after the identity check.
 */
export async function serverAnswers(discovery: ServerDiscovery, token: string): Promise<boolean> {
  if (!(await isServerIdentity(discovery.port, discovery.serverId))) return false
  const response = await fetch(`http://127.0.0.1:${discovery.port}/health`, {
    headers: { [TOKEN_HEADER]: token },
    redirect: "error",
    signal: AbortSignal.timeout(2_000),
  }).catch(() => null)
  return response?.ok === true
}
