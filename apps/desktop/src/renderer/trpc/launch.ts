import { TRPCClientError } from "@trpc/client"

/** How many times one start is sent before its error is shown. */
const LAUNCH_ATTEMPTS = 3

/**
 * True when a call failed because the WebSocket closed or errored before its
 * reply arrived. tRPC's WebSocket client then fails the call with the socket's
 * close or error event (not an Error) or its own closed error. A server error
 * always carries a `shape`.
 */
function replyLost(error: unknown): boolean {
  if (!(error instanceof TRPCClientError) || error.shape !== undefined) return false
  const cause: unknown = error.cause
  return !(cause instanceof Error) || cause.name === "TRPCWebSocketClosedError"
}

/**
 * Run one "start agent" action with a fresh launch ID. When the reply is lost,
 * send the same start again with the same ID: the server returns the first
 * result instead of starting a second agent. A server error is not retried.
 * The WebSocket client queues the retry until it has reconnected.
 */
export function startOnce<T>(start: (launchId: string) => Promise<T>): Promise<T> {
  const launchId = crypto.randomUUID()
  const attempt = (number: number): Promise<T> =>
    start(launchId).catch((error: unknown) => {
      if (number >= LAUNCH_ATTEMPTS || !replyLost(error)) throw error
      console.warn(`[pi-lab] start reply lost; retrying launch ${launchId}`, error)
      return attempt(number + 1)
    })
  return attempt(1)
}

/** A mutation's options whose input may carry a launch ID. */
interface LaunchMutationOptions<TInput, TOutput> {
  mutationFn?: (input: TInput, ...rest: never[]) => Promise<TOutput>
}

/**
 * Wrap tRPC mutation options of an agent start (`sessions.start` and the other
 * start buttons) so every call runs through {@link startOnce}.
 */
export function withLaunchId<
  TInput extends { launchId?: string },
  TOutput,
  TOptions extends LaunchMutationOptions<TInput, TOutput>,
>(options: TOptions & LaunchMutationOptions<TInput, TOutput>): TOptions {
  const run = options.mutationFn
  if (!run) throw new Error("withLaunchId needs mutation options with a mutation function")
  return {
    ...options,
    mutationFn: (input: TInput, ...rest: never[]) =>
      startOnce((launchId) => run({ ...input, launchId }, ...rest)),
  }
}
