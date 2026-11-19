import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createSecretStore, KEYCHAIN_SERVICE, type KeychainPort, macKeychain } from "./secrets"

/** FAKE in-memory keychain: proves the store logic only, not the real macOS Keychain. */
function fakeKeychain(): KeychainPort & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    read: (s, a) => items.get(`${s}/${a}`) ?? null,
    write: (s, a, secret) => void items.set(`${s}/${a}`, secret),
    remove: (s, a) => void items.delete(`${s}/${a}`),
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pl-secrets-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("secret store", () => {
  it("round trips and writes a 0600 key file", () => {
    const store = createSecretStore({
      dataDir: dir,
      keychain: fakeKeychain(),
      hasSavedValues: () => false,
    })
    const enc = store.encrypt("sk-test")
    expect(enc.startsWith("pl1:")).toBe(true)
    expect(enc).not.toContain("sk-test")
    expect(store.decrypt(enc)).toBe("sk-test")
    expect(store.isCurrentFormat(enc)).toBe(true)
    expect(statSync(join(dir, "secrets.key")).mode & 0o777).toBe(0o600)
    expect(store.protection()).toBe("file")
  })

  it("refuses a key file that others can read", () => {
    const first = createSecretStore({
      dataDir: dir,
      keychain: fakeKeychain(),
      hasSavedValues: () => false,
    })
    first.encrypt("x")
    chmodSync(join(dir, "secrets.key"), 0o644)
    const second = createSecretStore({
      dataDir: dir,
      keychain: fakeKeychain(),
      hasSavedValues: () => false,
    })
    expect(() => second.encrypt("x")).toThrow(/permissions/)
  })

  it("throws a clear error for legacy values without the prefix", () => {
    const store = createSecretStore({
      dataDir: dir,
      keychain: fakeKeychain(),
      hasSavedValues: () => false,
    })
    expect(store.isCurrentFormat("AAAA")).toBe(false)
    expect(() => store.decrypt("AAAA")).toThrow(/older PI Lab.*Open the PI Lab app once/)
  })

  it("switches file -> keychain -> file and keeps old values readable (fake keychain)", () => {
    const keychain = fakeKeychain()
    const store = createSecretStore({ dataDir: dir, keychain, hasSavedValues: () => false })
    const before = store.encrypt("secret-1")

    store.setProtection("keychain")
    expect(store.protection()).toBe("keychain")
    expect(existsSync(join(dir, "secrets.key"))).toBe(false)
    expect(keychain.items.size).toBe(1)
    expect(store.decrypt(before)).toBe("secret-1")
    const mid = store.encrypt("secret-2")

    // A new store instance reads the key from the keychain.
    const reopened = createSecretStore({ dataDir: dir, keychain, hasSavedValues: () => false })
    expect(reopened.protection()).toBe("keychain")
    expect(reopened.decrypt(before)).toBe("secret-1")

    store.setProtection("file")
    expect(store.protection()).toBe("file")
    expect(keychain.items.size).toBe(0)
    expect(statSync(join(dir, "secrets.key")).mode & 0o777).toBe(0o600)
    expect(store.decrypt(before)).toBe("secret-1")
    expect(store.decrypt(mid)).toBe("secret-2")
  })
})

describe.skipIf(process.env.PI_LAB_TEST_REAL_KEYCHAIN !== "1")("real macOS keychain", () => {
  it("writes, reads and removes an item", () => {
    const account = `test-${randomUUID()}`
    try {
      expect(macKeychain.read(KEYCHAIN_SERVICE, account)).toBeNull()
      macKeychain.write(KEYCHAIN_SERVICE, account, "abc123")
      expect(macKeychain.read(KEYCHAIN_SERVICE, account)).toBe("abc123")
    } finally {
      macKeychain.remove(KEYCHAIN_SERVICE, account)
    }
    expect(macKeychain.read(KEYCHAIN_SERVICE, account)).toBeNull()
  })
})

describe("lost key", () => {
  it("with saved values and no key anywhere, the store refuses to make a new key", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-lab-secrets-lost-"))
    // Fake keychain (labelled): the item was deleted or reset.
    const store = createSecretStore({
      dataDir: dir,
      keychain: fakeKeychain(),
      hasSavedValues: () => true,
    })
    expect(() => store.encrypt("x")).toThrow(/key that protects your saved API keys is missing/)
    expect(existsSync(join(dir, "secrets.key"))).toBe(false)
  })
})
