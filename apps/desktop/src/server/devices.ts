import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  assertOwnerOnly,
  ensureLocalToken,
  TOKEN_FILE,
  tokenMatches,
  writeOwnerOnly,
} from "./access"

/** Device registry in the data folder, owner-only. Holds token hashes, never tokens. */
export const DEVICES_FILE = "devices.json"

/** Id of the device that holds the local token file (the app on this machine). */
export const LOCAL_DEVICE_ID = "local"

/** One device that may connect to this server. */
export interface DeviceInfo {
  id: string
  name: string
  /** Epoch ms. */
  createdAt: number
  /** Epoch ms, or null while the token is valid. */
  revokedAt: number | null
  /** True for the local token file's device; it cannot be revoked. */
  local: boolean
}

interface StoredDevice {
  id: string
  name: string
  createdAt: number
  revokedAt: number | null
  /** SHA-256 of the token, hex. */
  tokenHash: string
}

/** What the HTTP layer needs: who a token belongs to, and how to close a device's sockets. */
export interface DeviceAccess {
  /** The device id a presented token belongs to, or null when it is unknown or revoked. */
  authenticate: (token: string | null) => string | null
  /** Remember an open connection of a device; returns the function that forgets it. */
  track: (deviceId: string, close: () => void) => () => void
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/**
 * Devices allowed to connect. The local device is the owner-only token file
 * (`server-token`), so the app on this machine connects with no setup. Other
 * devices get a token once, at creation; only its SHA-256 hash is stored.
 * Revoking a device closes its open connections at once.
 */
export class DeviceRegistry implements DeviceAccess {
  readonly #path: string
  readonly #tokenPath: string
  readonly #localToken: string
  readonly #connections = new Map<string, Set<() => void>>()

  constructor(dataDir: string) {
    this.#path = join(dataDir, DEVICES_FILE)
    this.#tokenPath = join(dataDir, TOKEN_FILE)
    this.#localToken = ensureLocalToken(dataDir)
  }

  authenticate(token: string | null): string | null {
    if (!token) return null
    if (tokenMatches(this.#localToken, token)) return LOCAL_DEVICE_ID
    const presented = Buffer.from(hashToken(token), "hex")
    const device = this.#read().find((entry) =>
      timingSafeEqual(Buffer.from(entry.tokenHash, "hex"), presented),
    )
    return device && device.revokedAt === null ? device.id : null
  }

  track(deviceId: string, close: () => void): () => void {
    let set = this.#connections.get(deviceId)
    if (!set) {
      set = new Set()
      this.#connections.set(deviceId, set)
    }
    set.add(close)
    return () => {
      set.delete(close)
    }
  }

  /** The local device first, then the others in creation order. */
  list(): DeviceInfo[] {
    const local: DeviceInfo = {
      id: LOCAL_DEVICE_ID,
      name: "This Mac",
      createdAt: statSync(this.#tokenPath).birthtimeMs,
      revokedAt: null,
      local: true,
    }
    return [
      local,
      ...this.#read().map((device) => ({
        id: device.id,
        name: device.name,
        createdAt: device.createdAt,
        revokedAt: device.revokedAt,
        local: false,
      })),
    ]
  }

  /** Add a device. Its token is returned here only; the server keeps just the hash. */
  create(name: string): { device: DeviceInfo; token: string } {
    const token = randomBytes(32).toString("base64url")
    const stored: StoredDevice = {
      id: randomUUID(),
      name,
      createdAt: Date.now(),
      revokedAt: null,
      tokenHash: hashToken(token),
    }
    this.#write([...this.#read(), stored])
    return {
      device: {
        id: stored.id,
        name,
        createdAt: stored.createdAt,
        revokedAt: null,
        local: false,
      },
      token,
    }
  }

  /** Revoke a device's token and close its open connections. */
  revoke(id: string): void {
    if (id === LOCAL_DEVICE_ID) throw new Error("The local device cannot be revoked")
    const devices = this.#read()
    const device = devices.find((entry) => entry.id === id)
    if (!device) throw new Error(`No device ${id}`)
    if (device.revokedAt === null) {
      device.revokedAt = Date.now()
      this.#write(devices)
    }
    for (const close of this.#connections.get(id) ?? []) close()
    this.#connections.delete(id)
  }

  #read(): StoredDevice[] {
    if (!existsSync(this.#path)) return []
    assertOwnerOnly(this.#path)
    return JSON.parse(readFileSync(this.#path, "utf8")) as StoredDevice[]
  }

  #write(devices: StoredDevice[]): void {
    writeOwnerOnly(this.#path, `${JSON.stringify(devices, null, 2)}\n`)
  }
}
