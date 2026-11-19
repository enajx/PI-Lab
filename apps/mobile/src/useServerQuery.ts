import { useCallback, useEffect, useState } from "react"
import { type Client, useConnection } from "./connection"

/** A query's state: the last data, the last error, and a way to read it again. */
export interface QueryState<T> {
  data: T | null
  error: string | null
  reload: () => void
}

/**
 * Run `read` with the current client: on every new connection, when the calls
 * socket opens again, and on `reload`. `key` names the inputs; a new key reads again.
 */
export function useServerQuery<T>(
  key: string,
  read: (client: Client) => Promise<T>,
): QueryState<T> {
  const { connection } = useConnection()
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  const reload = useCallback(() => setRound((value) => value + 1), [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: `read` changes every render; `key` names its inputs.
  useEffect(() => {
    if (!connection) return
    let current = true
    // A new key or connection: never show the previous read's data or error.
    setData(null)
    setError(null)
    const run = () =>
      read(connection.client).then(
        (value) => {
          if (!current) return
          setData(value)
          setError(null)
        },
        (reason: unknown) => {
          if (current) setError(reason instanceof Error ? reason.message : String(reason))
        },
      )
    void run()
    const stop = connection.status.onReopened((name) => {
      if (name === "calls") void run()
    })
    return () => {
      current = false
      stop()
    }
  }, [connection, key, round])

  return { data, error, reload }
}
