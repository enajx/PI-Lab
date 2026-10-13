import { useTranslate } from "../../../i18n/language"

type Change = { id: number; kind: "added" | "removed" | "unchanged"; text: string }
type ChangeLine = Omit<Change, "id">

/** Show a line diff for the two project files awaiting approval. */
function changedLines(original: string, proposed: string): Change[] {
  const before = original.split("\n")
  const after = proposed.split("\n")
  if (before.at(-1) === "") before.pop()
  if (after.at(-1) === "") after.pop()

  // Bound memory for unusually large documents. The review still shows every line.
  if (before.length * after.length > 160_000) {
    return [
      ...before.map((line) => ({ kind: "removed" as const, text: line })),
      ...after.map((line) => ({ kind: "added" as const, text: line })),
    ].map((line, id) => ({ ...line, id }))
  }
  const lengths = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1))
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const row = lengths[i]
    if (!row) throw new Error("Diff row missing")
    for (let j = after.length - 1; j >= 0; j -= 1) {
      row[j] =
        before[i] === after[j]
          ? (lengths[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(lengths[i + 1]?.[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const result: ChangeLine[] = []
  let i = 0
  let j = 0
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      result.push({ kind: "unchanged", text: before[i] ?? "" })
      i += 1
      j += 1
    } else if (
      j < after.length &&
      (i === before.length || (lengths[i]?.[j + 1] ?? 0) >= (lengths[i + 1]?.[j] ?? 0))
    ) {
      result.push({ kind: "added", text: after[j] ?? "" })
      j += 1
    } else {
      result.push({ kind: "removed", text: before[i] ?? "" })
      i += 1
    }
  }
  return result.map((line, id) => ({ ...line, id }))
}

/** Mark added and removed lines before either project file is written. */
export function ProjectDiff({
  title,
  original,
  proposed,
}: {
  title: string
  original: string
  proposed: string
}) {
  const t = useTranslate()
  const lines = changedLines(original, proposed)
  return (
    <section aria-label={`${title} ${t("diff")}`} className="rounded border border-border">
      <h3 className="border-border border-b px-2 py-1 font-medium text-sm">{title}</h3>
      <div className="max-h-48 overflow-auto bg-background font-mono text-xs">
        {lines.length === 0 ? (
          <p className="p-2 text-muted-foreground">{t("(new empty file)")}</p>
        ) : null}
        {lines.map((line) => (
          <div
            key={line.id}
            className={`whitespace-pre-wrap break-all px-2 ${
              line.kind === "added"
                ? "bg-green-500/15 text-green-700 dark:text-green-300"
                : line.kind === "removed"
                  ? "bg-red-500/15 text-red-700 dark:text-red-300"
                  : ""
            }`}
          >
            <span aria-hidden="true" className="mr-2 select-none">
              {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
            </span>
            <span data-change={line.kind}>{line.text || " "}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
