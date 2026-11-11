/** Main-process-only encryption boundary for locally stored credentials (API keys, tokens). */
export interface CredentialCipher {
  encrypt: (value: string) => string
  /** Reverse {@link CredentialCipher.encrypt}. Main process only; never sent to the renderer. */
  decrypt: (encrypted: string) => string
}

const TEST_PREFIX = "pi-lab-test:"

/** Test-only deterministic cipher: keeps plaintext out of the database without touching Electron. */
export const testCredentialCipher: CredentialCipher = {
  encrypt: (value) => Buffer.from(`${TEST_PREFIX}${value}`, "utf8").toString("base64"),
  decrypt: (encrypted) => {
    const text = Buffer.from(encrypted, "base64").toString("utf8")
    if (!text.startsWith(TEST_PREFIX)) throw new Error("Not a test-cipher value")
    return text.slice(TEST_PREFIX.length)
  },
}
