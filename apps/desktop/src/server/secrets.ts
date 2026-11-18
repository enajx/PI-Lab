import { execFileSync } from "node:child_process"
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { CredentialCipher } from "../main/setup/credentials"

/** Where the secret key is kept. Only one place holds it at any time. */
export type SecretProtection = "file" | "keychain"

/** Minimal OS keychain access, so tests can use a fake. */
export interface KeychainPort {
  read(service: string, account: string): string | null
  write(service: string, account: string, secret: string): void
  remove(service: string, account: string): void
}

export interface SecretStore extends CredentialCipher {
  protection(): SecretProtection
  setProtection(mode: SecretProtection): void
  /** True when the value was written by this format (has the version prefix). */
  isCurrentFormat(encrypted: string): boolean
}

export const KEYCHAIN_SERVICE = "PI Lab secrets"
const PREFIX = "pl1:"
const KEY_FILE = "secrets.key"

/** Run `/usr/bin/security`; returns stdout. Throws on a non-zero exit. */
function security(args: string[]): string {
  if (process.platform !== "darwin") {
    throw new Error("The macOS Keychain is only available on macOS.")
  }
  return execFileSync("/usr/bin/security", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
}

/** Keychain access through the macOS `security` tool. */
export const macKeychain: KeychainPort = {
  read(service, account) {
    try {
      return security(["find-generic-password", "-s", service, "-a", account, "-w"]).replace(
        /\n$/,
        "",
      )
    } catch (error) {
      // Exit code 44: item not found. Anything else is a real failure.
      if ((error as { status?: number }).status === 44) return null
      throw error
    }
  },
  write(service, account, secret) {
    security(["add-generic-password", "-U", "-s", service, "-a", account, "-w", secret])
  },
  remove(service, account) {
    try {
      security(["delete-generic-password", "-s", service, "-a", account])
    } catch (error) {
      if ((error as { status?: number }).status === 44) return
      throw error
    }
  },
}

/** Create the secret store for one data directory. */
export function createSecretStore(options: {
  dataDir: string
  keychain: KeychainPort
}): SecretStore {
  const { dataDir, keychain } = options
  const keyPath = join(dataDir, KEY_FILE)
  // The account depends on the data dir, so channels with separate data dirs do not collide.
  const account = createHash("sha256").update(dataDir).digest("hex").slice(0, 32)
  let cached: Buffer | null = null

  function readKeyFile(): Buffer {
    const mode = statSync(keyPath).mode & 0o777
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `Refusing to use ${keyPath}: its permissions (${mode.toString(8)}) allow group or other access. Run: chmod 600 "${keyPath}"`,
      )
    }
    const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64")
    if (key.length !== 32) throw new Error(`${keyPath} does not hold a 32-byte key.`)
    return key
  }

  function writeKeyFile(key: Buffer): void {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    writeFileSync(keyPath, key.toString("base64"), { mode: 0o600 })
  }

  function loadKey(): Buffer {
    if (cached) return cached
    if (existsSync(keyPath)) {
      cached = readKeyFile()
      return cached
    }
    const stored = keychain.read(KEYCHAIN_SERVICE, account)
    if (stored !== null) {
      cached = Buffer.from(stored, "base64")
      if (cached.length !== 32) throw new Error("The Keychain item holds a bad key.")
      return cached
    }
    const key = randomBytes(32)
    writeKeyFile(key)
    cached = key
    return key
  }

  return {
    encrypt(value) {
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", loadKey(), iv)
      const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
      return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")
    },
    decrypt(encrypted) {
      if (!encrypted.startsWith(PREFIX)) {
        throw new Error(
          "This key was saved by an older PI Lab. Open the PI Lab app once to move it to the new format.",
        )
      }
      const raw = Buffer.from(encrypted.slice(PREFIX.length), "base64")
      const decipher = createDecipheriv("aes-256-gcm", loadKey(), raw.subarray(0, 12))
      decipher.setAuthTag(raw.subarray(12, 28))
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")
    },
    isCurrentFormat(encrypted) {
      return encrypted.startsWith(PREFIX)
    },
    protection() {
      loadKey()
      return existsSync(keyPath) ? "file" : "keychain"
    },
    setProtection(mode) {
      const key = loadKey()
      const inFile = existsSync(keyPath)
      if (mode === "keychain" && inFile) {
        keychain.write(KEYCHAIN_SERVICE, account, key.toString("base64"))
        rmSync(keyPath)
      } else if (mode === "file" && !inFile) {
        writeKeyFile(key)
        keychain.remove(KEYCHAIN_SERVICE, account)
      }
    },
  }
}
