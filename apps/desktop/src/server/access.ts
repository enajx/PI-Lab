import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Local access files in the data folder. `server-token` is the local device
 * token, readable only by the owner, so the desktop app on the same machine
 * connects with no setup. `server.json` tells clients where the server listens.
 */
export const TOKEN_FILE = "server-token"
export const DISCOVERY_FILE = "server.json"

/** Stable id of this server's machine, created once, owner-only. */
export const MACHINE_ID_FILE = "machine-id"

/** Header carrying the device token on plain HTTP requests. */
export const TOKEN_HEADER = "x-pi-lab-token"

/**
 * Unauthenticated path where the server proves it holds the token:
 * `GET /identity?nonce=<hex>` answers `{ proof }` (see {@link identityProof}).
 */
export const IDENTITY_PATH = "/identity"

/** `POST` with a remote device's token revokes that device (204); the local token gets 403. */
export const DEVICE_REVOKE_PATH = "/device/revoke"

/** A nonce the server accepts: 32 to 128 lowercase hex characters. */
export const IDENTITY_NONCE = /^[0-9a-f]{32,128}$/

/** What the server writes to `server.json` once it listens. */
export interface ServerDiscovery {
  port: number
  pid: number
  build: string
  /**
   * Random id, new on every server start. Clients use it to notice a
   * restarted server; the identity proof is the HMAC, not this id.
   */
  serverId: string
}

/** Write a file with owner-only permissions, atomically (temp file and rename). */
export function writeOwnerOnly(path: string, content: string): void {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, content, { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, path)
}

/** Refuse a file that group or other users can read or write. */
export function assertOwnerOnly(path: string): void {
  const mode = statSync(path).mode & 0o777
  if ((mode & 0o077) !== 0) {
    throw new Error(`${path} is readable by other users (mode ${mode.toString(8)}); expected 600`)
  }
}

/** Read this server's machine id, creating it on first start. */
export function ensureMachineId(dataDir: string): string {
  const path = join(dataDir, MACHINE_ID_FILE)
  if (!existsSync(path)) writeOwnerOnly(path, `${randomUUID()}\n`)
  assertOwnerOnly(path)
  const id = readFileSync(path, "utf8").trim()
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`${path} does not hold a valid machine id`)
  return id
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

/** The proof for one nonce: hex `HMAC-SHA256(token, "pi-lab-identity:" + nonce)`. */
export function identityProof(token: string, nonce: string): string {
  return createHmac("sha256", token).update(`pi-lab-identity:${nonce}`).digest("hex")
}

/**
 * True when the process listening on `port` proves it holds `token`: it is
 * sent a new random nonce and must answer its HMAC. Clients call this before
 * they send the token, so a process that took a stale port (and replays an
 * earlier answer) never gets it. Redirects are refused.
 */
export async function proveServerIdentity(port: number, token: string): Promise<boolean> {
  return checkIdentity(port, token, null)
}

/**
 * The key a server proves a remote device's token with: the token's SHA-256
 * (hex), which is all the server stores (`devices.json`).
 */
export function deviceProofKey(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/**
 * True when the process on `port` (a remote server reached through a tunnel)
 * proves it knows the token of device `deviceId`: it answers the HMAC of a new
 * nonce keyed with {@link deviceProofKey}. A revoked or unknown device gets no
 * proof. Clients call this before they send the token.
 */
export async function proveDeviceIdentity(
  port: number,
  deviceId: string,
  token: string,
): Promise<boolean> {
  return checkIdentity(port, deviceProofKey(token), deviceId)
}

async function checkIdentity(port: number, key: string, deviceId: string | null): Promise<boolean> {
  const nonce = randomBytes(16).toString("hex")
  const device = deviceId === null ? "" : `&device=${encodeURIComponent(deviceId)}`
  const response = await fetch(`http://127.0.0.1:${port}${IDENTITY_PATH}?nonce=${nonce}${device}`, {
    redirect: "error",
    signal: AbortSignal.timeout(2_000),
  }).catch(() => null)
  if (!response?.ok) return false
  const body = (await response.json().catch(() => null)) as { proof?: unknown } | null
  if (typeof body?.proof !== "string") return false
  const expected = Buffer.from(identityProof(key, nonce))
  const presented = Buffer.from(body.proof)
  return expected.length === presented.length && timingSafeEqual(expected, presented)
}

/**
 * True when the PI Lab server named by `discovery` is the process on its port
 * and accepts `token`. The token is sent only after the identity check.
 */
export async function serverAnswers(discovery: ServerDiscovery, token: string): Promise<boolean> {
  if (!(await proveServerIdentity(discovery.port, token))) return false
  const response = await fetch(`http://127.0.0.1:${discovery.port}/health`, {
    headers: { [TOKEN_HEADER]: token },
    redirect: "error",
    signal: AbortSignal.timeout(2_000),
  }).catch(() => null)
  return response?.ok === true
}
