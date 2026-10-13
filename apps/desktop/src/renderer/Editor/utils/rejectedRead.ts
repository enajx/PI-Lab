import { readInterfaceLanguage } from "../../i18n/language"
import { translate } from "../../i18n/messages"
import type { RouterOutputs } from "../../trpc/types"

export type RejectedRead = Extract<
  RouterOutputs["files"]["read"],
  { status: "oversized" | "binary" }
> & { relPath: string }

/** Explain a rejected read without presenting partial contents as an editable file. */
export function rejectedReadMessage(read: RejectedRead): string {
  const language = readInterfaceLanguage()
  const size = new Intl.NumberFormat(language).format(read.size)
  const limit =
    read.status === "oversized" ? new Intl.NumberFormat(language).format(read.limit) : ""
  const template =
    read.status === "oversized"
      ? translate(language, "{path} is {size} bytes, above the {limit}-byte editor limit.")
      : translate(language, "{path} is a binary file ({size} bytes) and cannot be opened as text.")
  return template
    .replaceAll("{path}", read.relPath)
    .replaceAll("{size}", size)
    .replaceAll("{limit}", limit)
}
