/** Main-process-only encryption boundary for locally stored provider API keys. */
export interface CredentialCipher {
  encrypt: (value: string) => string
}

/** Test-only deterministic cipher: keeps plaintext out of the database without touching Electron. */
export const testCredentialCipher: CredentialCipher = {
  encrypt: (value) => Buffer.from(`pi-lab-test:${value}`, "utf8").toString("base64"),
}
