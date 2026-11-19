import type { Inbox } from "./inbox"

/** The part of the server API that answers a waiting agent. */
export interface AnswerApi {
  answerRequest: (input: {
    requestId: string
    text: string
  }) => Promise<{ status: "accepted" | "already-answered" }>
}

/** What the screen shows after an answer: the status and a message for the user, if any. */
export interface AnswerResult {
  status: "accepted" | "already-answered"
  notice: string | null
}

/**
 * Answer a waiting agent with `server.answerRequest`. Accepted or already
 * answered, the item leaves the Inbox; when another device answered first the
 * user is told. A failed call throws and leaves the item, so it can be sent again.
 */
export async function answerInboxItem(
  api: AnswerApi,
  inbox: Inbox,
  requestId: string,
  text: string,
): Promise<AnswerResult> {
  const { status } = await api.answerRequest({ requestId, text })
  inbox.remove(requestId)
  return {
    status,
    notice: status === "already-answered" ? "Another device already answered this request." : null,
  }
}
