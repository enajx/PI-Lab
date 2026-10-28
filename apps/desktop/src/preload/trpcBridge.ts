import type { Operation } from "@trpc/client"
import type { TRPCResponseMessage } from "@trpc/server/rpc"

export type RendererTrpcRequest =
  | { method: "request"; operation: Operation }
  | { method: "subscription.stop"; id: number }

export type WireTrpcRequest =
  | { method: "request"; operation: Omit<Operation, "id"> & { id: string } }
  | { method: "subscription.stop"; id: string }

export interface DocumentTrpcPort {
  send: (message: WireTrpcRequest) => void
  onMessage: (listener: (response: TRPCResponseMessage) => void) => void
}

export interface DocumentTrpcBridge {
  sendMessage: (message: RendererTrpcRequest) => void
  onMessage: (listener: (response: TRPCResponseMessage) => void) => void
}

/**
 * Scope wire IDs to one preload document. Late replies from a replaced page
 * cannot match requests in its replacement. JSON-RPC permits string wire IDs;
 * the upstream renderer link receives its original numeric IDs.
 */
export function createDocumentTrpcBridge(
  documentId: string,
  port: DocumentTrpcPort,
): DocumentTrpcBridge {
  if (!documentId || documentId.includes(":")) throw new Error("Invalid IPC document ID")
  const prefix = `${documentId}:`
  return {
    sendMessage(message): void {
      const id = message.method === "request" ? message.operation.id : message.id
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid IPC request ID")
      const wireId = `${prefix}${id}`
      if (message.method === "request")
        port.send({ ...message, operation: { ...message.operation, id: wireId } })
      else port.send({ method: "subscription.stop", id: wireId })
    },
    onMessage(listener): void {
      port.onMessage((response) => {
        if (!response || typeof response.id !== "string" || !response.id.startsWith(prefix)) return
        const suffix = response.id.slice(prefix.length)
        if (!/^[1-9]\d{0,15}$/.test(suffix)) return
        const id = Number(suffix)
        if (Number.isSafeInteger(id)) listener({ ...response, id })
      })
    },
  }
}
