/**
 * Derive a short, human display name for an external link from its URL — the
 * hostname's second-level domain label (e.g. `https://www.overleaf.com/x/y` →
 * `overleaf`, `github.com/a/b` → `github`). Strips the protocol and a leading
 * `www.`, then takes the second-to-last dot-label of the hostname.
 *
 * Deliberately a simple rule (no public-suffix list), so multi-part TLDs like
 * `example.co.uk` yield `co` — acceptable for the card's compact link labels.
 * Falls back to the hostname, or the trimmed input itself, when the URL can't be
 * parsed (so a malformed entry still shows *something*).
 */
export function deriveLinkName(url: string): string {
  const trimmed = url.trim()
  if (trimmed.length === 0) return trimmed

  // Prepend a scheme when missing so `www.overleaf.com/x` still parses as a URL.
  const hasScheme = /^[a-zA-Z][\w+.-]*:\/\//.test(trimmed)
  const candidate = hasScheme ? trimmed : `https://${trimmed}`

  let hostname: string
  try {
    hostname = new URL(candidate).hostname
  } catch {
    // Unparseable input (e.g. spaces): fall back to the raw text.
    return trimmed
  }
  if (hostname.length === 0) return trimmed

  const host = hostname.replace(/^www\./, "")
  const labels = host.split(".").filter((label) => label.length > 0)
  if (labels.length === 0) return host
  if (labels.length === 1) return labels[0] ?? host
  return labels[labels.length - 2] ?? host
}
