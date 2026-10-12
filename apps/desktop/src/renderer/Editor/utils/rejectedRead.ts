import type { RouterOutputs } from "../../trpc/types"

export type RejectedRead = Extract<
  RouterOutputs["files"]["read"],
  { status: "oversized" | "binary" }
> & { relPath: string }

/** Explain a rejected read without presenting partial contents as an editable file. */
export function rejectedReadMessage(read: RejectedRead): string {
  const size = `${read.size.toLocaleString("en-US")} bytes`
  return read.status === "oversized"
    ? `${read.relPath} is ${size}, above the ${read.limit.toLocaleString("en-US")}-byte editor limit.`
    : `${read.relPath} is a binary file (${size}) and cannot be opened as text.`
}
