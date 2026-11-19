import { useQuery } from "@tanstack/react-query"
import { loopbackPort, machineGrantUrl, withPort } from "../../shared/machineUrls"
import { desktopIpc } from "../trpc/client"
import { useMachineScope } from "./machines"

/** How often the forwarded local port is asked again. */
const FORWARD_CHECK_MS = 5_000

/**
 * The URL to show in this page for a URL the server gave: unchanged for this
 * Mac's server. Inside a remote {@link MachineScope}, a report or media grant
 * names the machine (main forwards it there), and a notebook or marimo page on
 * the machine's 127.0.0.1 goes through a local port forwarded to it. `url` is
 * null while forwarding; `error` says why forwarding failed.
 */
export function useMachinePageUrl(url: string | null): {
  url: string | null
  error: string | null
} {
  const machineId = useMachineScope()?.machineId ?? null
  const port = machineId !== null && url !== null ? loopbackPort(url) : null
  const forward = useQuery({
    queryKey: ["machine-port-forward", machineId, port],
    queryFn: () => {
      if (machineId === null || port === null) throw new Error("Nothing to forward")
      return desktopIpc().desktop.machines.forwardPort.mutate({ machineId, port })
    },
    enabled: port !== null,
    // The forward can come back on another local port after it reconnects
    // (main/server/tunnel.ts); asking again moves the page to that port.
    refetchInterval: FORWARD_CHECK_MS,
    retry: false,
  })
  if (machineId === null || url === null) return { url, error: null }
  if (port === null) return { url: machineGrantUrl(url, machineId), error: null }
  if (forward.error) return { url: null, error: forward.error.message }
  return { url: forward.data ? withPort(url, forward.data.localPort) : null, error: null }
}
