import { useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import type { ServerCapability } from "../../shared/clientApi"
import { useTRPC } from "./react"

/**
 * True when the connected server lists `capability` in its hello. False while
 * the hello is loading or failed, so an action an older server lacks never
 * shows, not even briefly.
 */
export function useServerCapability(capability: ServerCapability): boolean {
  const trpc = useTRPC()
  const hello = useQuery(trpc.server.hello.queryOptions())
  return hello.data?.capabilities.includes(capability) === true
}

/** Show `children` only when the connected server supports `capability`. */
export function RequiresCapability(props: {
  capability: ServerCapability
  children: ReactNode
}): ReactNode {
  return useServerCapability(props.capability) ? props.children : null
}
