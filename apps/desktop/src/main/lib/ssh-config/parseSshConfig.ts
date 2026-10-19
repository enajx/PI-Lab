/**
 * Minimal, dependency-free OpenSSH client-config parser for Cluster monitoring.
 *
 * Scope is deliberately narrow: it extracts only the connection metadata the
 * Cluster tab needs to list and probe a machine — the `Host` alias and its
 * `HostName` / `User` / `Port`. It is **not** a general ssh_config interpreter:
 *
 *   - It reads only those four keywords; every other directive (IdentityFile,
 *     ProxyJump, …) is ignored — we never read, resolve, or surface key material.
 *   - It skips wildcard / pattern hosts (`Host *`, `Host gpu-?`), which describe
 *     defaults for many hosts rather than one concrete machine.
 *   - It does not follow `Include` directives or expand `%`-tokens; those are out
 *     of scope for a monitoring import and would pull in unrelated complexity.
 *
 * A single `Host` line may list several aliases — each becomes its own concrete
 * entry, all sharing the keyword block that follows. Keywords are matched
 * case-insensitively (ssh treats them so); the first occurrence of a keyword in
 * a block wins, mirroring ssh's "earliest value applies" precedence.
 */

export interface SshConfigHost {
  /** The `Host` alias — what `ssh <alias>` is invoked with. */
  alias: string
  /** Resolved `HostName` (real address), when the block declares one. */
  hostname?: string
  /** `User` login, when declared. */
  user?: string
  /** `Port`, when declared and a finite positive integer. */
  port?: number
}

/** True for an alias that is a pattern (matches many hosts), not one machine. */
function isPattern(alias: string): boolean {
  return alias.includes("*") || alias.includes("?") || alias.startsWith("!")
}

/**
 * Split a config line into `[keyword, value]`. ssh accepts either whitespace or
 * `=` as the separator (`Port 2222` and `Port=2222` are equivalent), and values
 * may be quoted. Returns `null` for blank lines and comments.
 */
function splitDirective(line: string): [keyword: string, value: string] | null {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.startsWith("#")) return null

  // Keyword ends at the first whitespace or `=`; the remainder (minus a leading
  // `=` / spaces) is the value.
  const match = trimmed.match(/^([^\s=]+)[\s=]+(.*)$/)
  if (!match) return null

  const keyword = match[1]?.toLowerCase() ?? ""
  let value = match[2]?.trim() ?? ""
  // Strip one layer of surrounding quotes (ssh allows quoted values with spaces).
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1)
  }
  if (keyword.length === 0 || value.length === 0) return null
  return [keyword, value]
}

/**
 * Parse the body of an OpenSSH client config into concrete host entries.
 *
 * @param raw the full config file contents (callers read the file; this stays a
 *            pure string→data function so it is trivially unit-testable).
 */
export function parseSshConfig(raw: string): SshConfigHost[] {
  const entries: SshConfigHost[] = []
  // The host entries currently being filled (one `Host` line can open several).
  let active: SshConfigHost[] = []

  for (const line of raw.split(/\r?\n/)) {
    const directive = splitDirective(line)
    if (!directive) continue
    const [keyword, value] = directive

    if (keyword === "host") {
      active = []
      for (const alias of value.split(/\s+/)) {
        if (isPattern(alias)) continue
        const entry: SshConfigHost = { alias }
        entries.push(entry)
        active.push(entry)
      }
      continue
    }

    // Keyword outside any (non-pattern) Host block — e.g. a global default or a
    // directive under `Host *`. Nothing concrete to attach it to.
    if (active.length === 0) continue

    switch (keyword) {
      case "hostname":
        for (const entry of active) entry.hostname ??= value
        break
      case "user":
        for (const entry of active) entry.user ??= value
        break
      case "port": {
        const port = Number.parseInt(value, 10)
        if (Number.isInteger(port) && port > 0) {
          for (const entry of active) entry.port ??= port
        }
        break
      }
      // Every other directive (IdentityFile, ProxyJump, …) is intentionally
      // ignored — we never read key material for a monitoring import.
    }
  }

  return entries
}
