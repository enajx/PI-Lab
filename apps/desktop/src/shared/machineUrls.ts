/**
 * URLs a remote machine's server gives the renderer, made to work in this
 * app's page. Report and media grants (`pi-lab-report://<token>/…`,
 * `pi-lab-media://<token>/…`) carry the machine in the host,
 * `<token>.<machineId>`, so Electron's protocol handler forwards them to that
 * machine's server. Notebook and marimo pages (`http://127.0.0.1:<port>/…`)
 * go through a local port forwarded to that port on the machine.
 */

const GRANT_SCHEMES = ["pi-lab-report:", "pi-lab-media:"]

/** A report or media URL of `machineId`'s server, with the machine in its host; other URLs unchanged. */
export function machineGrantUrl(url: string, machineId: string): string {
  const parsed = new URL(url)
  if (!GRANT_SCHEMES.includes(parsed.protocol)) return url
  parsed.host = `${parsed.host}.${machineId}`
  return parsed.toString()
}

/** The grant token and the machine (null: this Mac's server) of a report or media URL's host. */
export function splitGrantHost(host: string): { token: string; machineId: string | null } {
  const dot = host.indexOf(".")
  return dot === -1
    ? { token: host, machineId: null }
    : { token: host.slice(0, dot), machineId: host.slice(dot + 1) }
}

/** The port of a page on the machine's loopback (`http://127.0.0.1:<port>/…`), or null. */
export function loopbackPort(url: string): number | null {
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.port === "") {
    return null
  }
  return Number(parsed.port)
}

/** The same URL on another local port. */
export function withPort(url: string, port: number): string {
  const parsed = new URL(url)
  parsed.port = String(port)
  return parsed.toString()
}
