import type { Project, ProjectDetails, ProjectTextTag } from "@pi-lab/local-db"
import { cn } from "@pi-lab/ui"
import { useQuery } from "@tanstack/react-query"
import { Plus, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useTranslate } from "../../../../../i18n/language"
import { useEmojiTagPalette } from "../../../../../preferences/preferences"
import { useTRPC } from "../../../../../trpc/react"

const FIELD_CLASS =
  "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/40"

// A compact, dependency-free picker keeps the selection experience consistent on
// every desktop platform instead of relying on an OS-specific character viewer.
const EMOJI_PICKER_OPTIONS = [
  "😀",
  "😂",
  "🥳",
  "😍",
  "🤔",
  "🙌",
  "👏",
  "💪",
  "🧠",
  "💡",
  "🔥",
  "✨",
  "⭐",
  "🌟",
  "🚀",
  "🛰️",
  "🔬",
  "🧪",
  "🧬",
  "📊",
  "📈",
  "📝",
  "📚",
  "💻",
  "⚙️",
  "🛠️",
  "🔭",
  "🧮",
  "🌍",
  "🌱",
  "☀️",
  "🌙",
  "🐍",
  "🦾",
  "🤖",
  "🦠",
  "🧫",
  "🧲",
  "⚛️",
  "🔗",
  "💼",
  "🥭",
  "🐬",
  "☑️",
] as const

/** Shared compact form for adding and editing project details. */
export function EditProjectDialog({
  project,
  mode,
  pending,
  error,
  onClose,
  onSave,
}: {
  project: Pick<Project, "name" | "typeId" | "metadata" | "agentConfig"> & { id?: string }
  mode: "add" | "edit"
  pending: boolean
  error: string | null
  onClose: () => void
  onSave: (details: ProjectDetails) => void
}) {
  const t = useTranslate()
  const trpc = useTRPC()
  const agents = useQuery(trpc.agents.list.queryOptions())
  const choice = useQuery({
    ...trpc.agents.projectChoice.queryOptions({ projectId: project.id ?? "" }),
    enabled: mode === "edit" && Boolean(project.id),
  })
  const existing = project.metadata
  const [name, setName] = useState(project.name)
  const [typeId, setTypeId] = useState(
    project.typeId === "paper"
      ? "manuscript"
      : ["research", "software", "manuscript"].includes(project.typeId)
        ? project.typeId
        : "",
  )
  const [agentChoice, setAgentChoice] = useState<string | null>(null)
  const agentId = agentChoice ?? choice.data?.agentId ?? ""
  const [deadline, setDeadline] = useState(existing?.deadline ?? "")
  const [emojiTags, setEmojiTags] = useState<string[]>(existing?.emojiTags ?? [])
  const [textTags, setTextTags] = useState<ProjectTextTag[]>(existing?.textTags ?? [])
  const [tagLabel, setTagLabel] = useState("")
  const addTextTag = () => {
    const label = tagLabel.trim()
    if (!label) return
    setTextTags((current) => [
      ...current.filter((tag) => tag.label !== label),
      { label, color: "blue" },
    ])
    setTagLabel("")
  }
  // The global, cross-project emoji palette (see module doc). The chips shown are
  // the UNION of this palette and the project's already-assigned tags, so a tag
  // already on the project (e.g. 🧠🔥) stays visible and manageable even if it was
  // never added to the palette.
  const [palette, setPalette] = useEmojiTagPalette()
  const [emojiPickerOpen, setEmojiPickerOpen] = useState<boolean>(false)
  const paletteChips = [...palette, ...emojiTags.filter((emoji) => !palette.includes(emoji))]

  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (emojiPickerOpen) {
        setEmojiPickerOpen(false)
        return
      }
      if (!pending) onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [emojiPickerOpen, onClose, pending])

  // Toggle whether THIS project is tagged with `emoji` (project-only; the global
  // palette is untouched).
  const toggleEmoji = (emoji: string) => {
    setEmojiTags((current) =>
      current.includes(emoji) ? current.filter((e) => e !== emoji) : [...current, emoji],
    )
  }

  // Add a picker choice to the GLOBAL palette and auto-assign it here.
  const addEmojiToPalette = (emoji: string) => {
    if (!palette.includes(emoji)) setPalette([...palette, emoji])
    setEmojiTags((current) => (current.includes(emoji) ? current : [...current, emoji]))
    setEmojiPickerOpen(false)
  }

  // Right-click: drop `emoji` from the global palette and unassign it from this
  // project's draft.
  const removeEmojiFromPalette = (emoji: string) => {
    setPalette(palette.filter((e) => e !== emoji))
    setEmojiTags((current) => current.filter((e) => e !== emoji))
  }

  const save = () => {
    if (!name.trim() || pending || (choice.isLoading && mode === "edit")) return
    onSave({
      name: name.trim(),
      typeId: (typeId || "general") as ProjectDetails["typeId"],
      deadline: deadline || null,
      agentId: agentId || null,
      emojiTags,
      textTags,
    })
  }

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is a click-to-dismiss surface; Escape (bound above) is the keyboard equivalent, and focus stays on the dialog's own controls.
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismissal mirrors Escape, which is already handled; a key handler here would duplicate it.
    <div
      data-testid="edit-project-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onClose()
      }}
    >
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-label={mode === "add" ? t("Add project") : `${t("Edit")} ${project.name}`}
        data-testid={mode === "add" ? "add-project-dialog" : "edit-project-dialog"}
        className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xl"
      >
        <div className="border-border border-b px-4 py-3">
          <h2 className="font-medium text-foreground text-sm">
            {t(mode === "add" ? "Add project" : "Edit project")}
          </h2>
          <p className="truncate text-muted-foreground text-xs">{project.name}</p>
        </div>

        <fieldset disabled={pending} className="flex flex-col gap-3.5 overflow-y-auto px-4 py-4">
          <label className="flex flex-col gap-1 text-xs font-medium">
            {t("Project name")}
            <input
              className={FIELD_CLASS}
              data-testid="edit-project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={pending}
            />
          </label>
          {mode === "edit" ? (
            <label className="flex flex-col gap-1 text-xs font-medium">
              {t("Project type")}
              <select
                data-testid="edit-project-type"
                className={FIELD_CLASS}
                value={typeId}
                onChange={(event) => setTypeId(event.target.value)}
                disabled={pending}
              >
                <option value="">{t("None")}</option>
                <option value="research">{t("Research")}</option>
                <option value="software">{t("Software")}</option>
                <option value="manuscript">{t("Manuscript")}</option>
              </select>
            </label>
          ) : null}
          <label className="flex flex-col gap-1 text-xs font-medium">
            {t("Agent")}
            <select
              data-testid="edit-project-agent"
              className={FIELD_CLASS}
              value={agentId}
              onChange={(event) => setAgentChoice(event.target.value)}
              disabled={pending || (choice.isLoading && mode === "edit")}
            >
              <option value="">{t("Use default agent from Settings")}</option>
              {agentId && !agents.data?.some((agent) => agent.id === agentId && agent.available) ? (
                <option value={agentId}>
                  {agentId} {t("(not installed)")}
                </option>
              ) : null}
              {agents.data
                ?.filter((agent) => agent.available)
                .map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.label}
                  </option>
                ))}
            </select>
          </label>
          {agents.error || choice.error ? (
            <p role="alert" className="text-xs text-destructive">
              {(agents.error ?? choice.error)?.message}
            </p>
          ) : null}
          {mode === "edit" ? (
            <>
              <label className="flex flex-col gap-1">
                <span className="font-medium text-foreground text-xs">{t("Deadline")}</span>
                <input
                  type="date"
                  data-testid="edit-project-deadline"
                  className={FIELD_CLASS}
                  value={deadline}
                  onChange={(event) => setDeadline(event.target.value)}
                />
              </label>

              <div className="flex flex-col gap-1.5">
                <span className="font-medium text-foreground text-xs">{t("Tags")}</span>
                <div
                  className="flex flex-wrap items-center gap-1.5"
                  data-testid="edit-project-emoji"
                >
                  {textTags.map((tag) => (
                    <button
                      type="button"
                      key={tag.label}
                      aria-label={`${t("Remove")} ${tag.label}`}
                      className="inline-flex items-center gap-1 rounded-full bg-brand/15 px-2 py-1 text-xs text-foreground"
                      onClick={() =>
                        setTextTags((current) => current.filter((item) => item.label !== tag.label))
                      }
                    >
                      {tag.label}
                      <X className="size-3" aria-hidden />
                    </button>
                  ))}
                  {paletteChips.map((emoji) => {
                    const active = emojiTags.includes(emoji)
                    return (
                      <button
                        key={emoji}
                        type="button"
                        data-testid="edit-project-emoji-choice"
                        data-emoji={emoji}
                        data-active={active}
                        aria-pressed={active}
                        onClick={() => toggleEmoji(emoji)}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          removeEmojiFromPalette(emoji)
                        }}
                        className={cn(
                          "flex size-8 items-center justify-center rounded-md border text-base transition-colors",
                          active ? "border-brand bg-brand/15" : "border-border hover:bg-accent/60",
                        )}
                      >
                        {emoji}
                      </button>
                    )
                  })}
                  <button
                    type="button"
                    data-testid="edit-project-emoji-add"
                    aria-label={t("Choose an emoji to add to the palette")}
                    title={t("Choose an emoji")}
                    onClick={() => setEmojiPickerOpen(true)}
                    className="flex size-8 items-center justify-center rounded-md border border-border border-dashed text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                  >
                    <Plus className="size-4" aria-hidden />
                  </button>

                  <label className="min-w-24 flex-1">
                    <span className="sr-only">{t("Text tag")}</span>
                    <input
                      data-testid="edit-project-tag-text"
                      className={FIELD_CLASS}
                      placeholder={t("Add tag")}
                      value={tagLabel}
                      maxLength={80}
                      onChange={(event) => setTagLabel(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault()
                          addTextTag()
                        }
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    data-testid="edit-project-tag-add"
                    aria-label={t("Add tag")}
                    disabled={!tagLabel.trim()}
                    onClick={addTextTag}
                    className="p-2 rounded border border-border disabled:opacity-50"
                  >
                    <Plus className="size-4" />
                  </button>
                </div>
              </div>
            </>
          ) : null}
          {error ? (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          ) : null}
        </fieldset>

        <div className="flex justify-end gap-2 border-border border-t px-4 py-3">
          {mode === "add" ? (
            <button
              type="button"
              disabled
              title={t("Coming later")}
              className="mr-auto rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground opacity-50"
            >
              {t("Plan research")}
            </button>
          ) : null}
          <button
            type="button"
            data-testid="edit-project-cancel"
            disabled={pending}
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            {t("Cancel")}
          </button>
          <button
            type="button"
            data-testid={mode === "add" ? "add-project-confirm" : "edit-project-save"}
            disabled={
              pending ||
              !name.trim() ||
              Boolean(choice.error) ||
              (mode === "edit" && choice.isLoading)
            }
            onClick={save}
            className="rounded-md bg-brand px-3 py-1.5 font-medium text-brand-foreground text-sm transition-colors hover:bg-brand/90"
          >
            {t(mode === "add" ? "Add project" : "Save")}
          </button>
        </div>
      </div>

      {emojiPickerOpen ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: this is the picker backdrop; its visible dialog contains the keyboard-accessible choices, and Escape closes it.
        // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled at dialog level and provides the keyboard dismissal path.
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-background/50 p-4"
          onClick={(event) => {
            if (event.target === event.currentTarget) setEmojiPickerOpen(false)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("Choose an emoji")}
            data-testid="edit-project-emoji-picker"
            className="w-full max-w-sm rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl"
          >
            <p className="mb-2 font-medium text-sm">{t("Choose an emoji")}</p>
            <div className="grid grid-cols-8 gap-1">
              {EMOJI_PICKER_OPTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  data-testid="edit-project-emoji-picker-choice"
                  data-emoji={emoji}
                  aria-label={`${t("Add")} ${emoji}`}
                  disabled={pending}
                  onClick={() => addEmojiToPalette(emoji)}
                  className="flex size-9 items-center justify-center rounded-md text-lg transition-colors hover:bg-accent/60 focus-visible:bg-accent/60"
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>,
    document.body,
  )
}
