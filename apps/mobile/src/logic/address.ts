/** The URLs the phone needs for one server. */
export interface Endpoint {
  /** The tRPC WebSocket URL with the device token in its `?token=` query. */
  trpcUrl: string
  /** `GET` with the `x-pi-lab-token` header: 200 when the token is accepted, 401 when refused. */
  healthUrl: string
  /** `http(s)://host[:port]`, for the plain HTTP routes (with the `x-pi-lab-token` header). */
  httpUrl: string
}

/** What the connect screen stores. */
export interface ServerLogin {
  address: string
  token: string
}

/**
 * The endpoint for a server address such as `http://10.0.2.2:4567` (cleartext,
 * for the emulator) or `https://mac.example.ts.net` (`tailscale serve`). An
 * address without a scheme is taken as https. Throws for anything else.
 */
export function endpointFor(address: string, token: string): Endpoint {
  // Parsed by hand: React Native's URL class implements only part of the standard.
  const trimmed = address.trim().replace(/\/+$/, "")
  const match = /^(?:([a-z]+):\/\/)?([^/?#\s]+)$/i.exec(trimmed)
  if (!match) throw new Error("The address must be a host and an optional port, without a path")
  const scheme = (match[1] ?? "https").toLowerCase()
  if (scheme !== "http" && scheme !== "https") {
    throw new Error(`The address must start with http:// or https:// (got ${scheme}://)`)
  }
  const host = match[2]
  const ws = scheme === "https" ? "wss" : "ws"
  return {
    trpcUrl: `${ws}://${host}/trpc?token=${encodeURIComponent(token)}`,
    healthUrl: `${scheme}://${host}/health`,
    httpUrl: `${scheme}://${host}`,
  }
}

/**
 * Read a pasted one-line connect link,
 * `pilab://connect?address=<address, URL encoded>&token=<token>`
 * (printed by apps/mobile/scripts/phone-link.mjs on the Mac). Null when the text is not one.
 */
export function parseConnectLink(text: string): ServerLogin | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith("pilab://connect?")) return null
  // A link still being typed can end in half an escape, which decodeURIComponent refuses.
  if (/%(?![0-9a-f]{2})/i.test(trimmed)) return null
  const query = new Map<string, string>()
  for (const pair of trimmed.slice("pilab://connect?".length).split("&")) {
    const equals = pair.indexOf("=")
    if (equals > 0) query.set(pair.slice(0, equals), decodeURIComponent(pair.slice(equals + 1)))
  }
  const address = query.get("address")
  const token = query.get("token")
  if (!address || !token) return null
  return { address, token }
}
