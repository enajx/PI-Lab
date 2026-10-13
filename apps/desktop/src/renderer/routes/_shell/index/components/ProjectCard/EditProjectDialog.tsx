import type { Project, ProjectMetadata, ProjectReferenceLink } from "@pi-lab/local-db"
import { cn } from "@pi-lab/ui"
import { Plus, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useTranslate } from "../../../../../i18n/language"
import { useEmojiTagPalette } from "../../../../../preferences/preferences"

/**
 * The "Edit project…" modal (reached from the project card's right-click menu). It
 * edits the extra, optional metadata surfaced under the card title —
 * collaborators, publishing venue, a deadline date, a set of emoji tags, and
 * external links (a URL each). On save it normalizes the form into a
 * {@link ProjectMetadata} (trimming and dropping empty fields) and hands it to
 * `onSave`; an all-empty form saves `null`, clearing the group. Closes on Escape,
 * on a backdrop click, or via Cancel.
 *
 * Emoji tags draw from a single GLOBAL palette ({@link useEmojiTagPalette}) shared
 * across every project: a chip is *active* when assigned to THIS project, clicking
 * toggles that assignment only, "+" opens a cross-platform emoji picker whose
 * choice joins the global palette, and right-clicking a chip removes it from it.
 */

/**
 * A reference-link row while editing. `id` is a stable React key for the row (rows
 * have no natural id and can be added/removed). Links are URL-only now — the stored
 * {@link ProjectReferenceLink.label} is no longer collected (the card derives a
 * display name from the URL's domain), but the field is kept optional server-side
 * so already-saved links aren't lost.
 */
interface LinkDraft {
  id: string
  url: string
}

/** A fresh, empty link-draft row. */
function newLinkDraft(): LinkDraft {
  return { id: crypto.randomUUID(), url: "" }
}

/** Seed the editable link rows from stored metadata (URL only). */
function toLinkDrafts(links: ProjectReferenceLink[] | undefined): LinkDraft[] {
  return (links ?? []).map((link) => ({ id: crypto.randomUUID(), url: link.url }))
}

/**
 * Collapse the form state into stored {@link ProjectMetadata}: trim every string,
 * drop empty fields, keep only links with a non-empty URL, and return `null` when
 * nothing remains (so an emptied form clears the whole group).
 */
function normalizeMetadata(input: {
  collaborators: string
  venue: string
  deadline: string
  emojiTags: string[]
  links: LinkDraft[]
}): ProjectMetadata | null {
  const collaborators = input.collaborators.trim()
  const venue = input.venue.trim()
  const deadline = input.deadline.trim()
  const referenceLinks: ProjectReferenceLink[] = input.links
    .map((link) => ({ url: link.url.trim() }))
    .filter((link) => link.url.length > 0)

  const metadata: ProjectMetadata = {}
  if (collaborators.length > 0) metadata.collaborators = collaborators
  if (venue.length > 0) metadata.venue = venue
  if (deadline.length > 0) metadata.deadline = deadline
  if (input.emojiTags.length > 0) metadata.emojiTags = input.emojiTags
  if (referenceLinks.length > 0) metadata.referenceLinks = referenceLinks

  return Object.keys(metadata).length > 0 ? metadata : null
}

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

export function EditProjectDialog({
  project,
  onClose,
  onSave,
}: {
  project: Pick<Project, "name" | "metadata">
  onClose: () => void
  onSave: (metadata: ProjectMetadata | null) => void
}) {
  const t = useTranslate()
  const existing = project.metadata
  const [collaborators, setCollaborators] = useState<string>(existing?.collaborators ?? "")
  const [venue, setVenue] = useState<string>(existing?.venue ?? "")
  const [deadline, setDeadline] = useState<string>(existing?.deadline ?? "")
  const [emojiTags, setEmojiTags] = useState<string[]>(existing?.emojiTags ?? [])
  const [links, setLinks] = useState<LinkDraft[]>(toLinkDrafts(existing?.referenceLinks))

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
      onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [emojiPickerOpen, onClose])

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

  const updateLink = (index: number, patch: Partial<LinkDraft>) => {
    setLinks((current) => current.map((link, i) => (i === index ? { ...link, ...patch } : link)))
  }

  const save = () => {
    onSave(normalizeMetadata({ collaborators, venue, deadline, emojiTags, links }))
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is a click-to-dismiss surface; Escape (bound above) is the keyboard equivalent, and focus stays on the dialog's own controls.
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismissal mirrors Escape, which is already handled; a key handler here would duplicate it.
    <div
      data-testid="edit-project-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${t("Edit")} ${project.name}`}
        data-testid="edit-project-dialog"
        className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xl"
      >
        <div className="border-border border-b px-4 py-3">
          <h2 className="font-medium text-foreground text-sm">{t("Edit project")}</h2>
          <p className="truncate text-muted-foreground text-xs">{project.name}</p>
        </div>

        <div className="flex flex-col gap-3.5 overflow-y-auto px-4 py-4">
          <label className="flex flex-col gap-1">
            <span className="font-medium text-foreground text-xs">{t("Collaborators")}</span>
            <input
              type="text"
              data-testid="edit-project-collaborators"
              className={FIELD_CLASS}
              value={collaborators}
              placeholder={t("e.g. Ada Lovelace, Alan Turing")}
              onChange={(event) => setCollaborators(event.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-medium text-foreground text-xs">{t("Publishing venue")}</span>
            <input
              type="text"
              data-testid="edit-project-venue"
              className={FIELD_CLASS}
              value={venue}
              placeholder={t("e.g. NeurIPS 2026")}
              onChange={(event) => setVenue(event.target.value)}
            />
          </label>

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
            <span className="font-medium text-foreground text-xs">{t("Emoji tags")}</span>
            <div className="flex flex-wrap items-center gap-1.5" data-testid="edit-project-emoji">
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
                    title={t("Click to tag this project · right-click to remove from the palette")}
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
            </div>
            <span className="text-[11px] text-muted-foreground">
              {t("Click to tag this project · right-click a tag to remove it from the palette")}
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="font-medium text-foreground text-xs">{t("External links")}</span>
            <div className="flex flex-col gap-2" data-testid="edit-project-links">
              {links.map((link, index) => (
                <div
                  key={link.id}
                  className="flex items-center gap-1.5"
                  data-testid="edit-project-link-row"
                >
                  <input
                    type="url"
                    data-testid="edit-project-link-url"
                    className={cn(FIELD_CLASS, "flex-1")}
                    value={link.url}
                    placeholder={t("e.g. https://www.overleaf.com/project/…")}
                    onChange={(event) => updateLink(index, { url: event.target.value })}
                  />
                  <button
                    type="button"
                    data-testid="edit-project-link-remove"
                    aria-label={t("Remove link")}
                    onClick={() => setLinks((current) => current.filter((_, i) => i !== index))}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                </div>
              ))}
              <button
                type="button"
                data-testid="edit-project-link-add"
                onClick={() => setLinks((current) => [...current, newLinkDraft()])}
                className="flex items-center gap-1.5 self-start rounded-md px-2 py-1 text-muted-foreground text-xs transition-colors hover:bg-accent/60 hover:text-foreground"
              >
                <Plus className="size-3.5" aria-hidden />
                {t("Add link")}
              </button>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-border border-t px-4 py-3">
          <button
            type="button"
            data-testid="edit-project-cancel"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            {t("Cancel")}
          </button>
          <button
            type="button"
            data-testid="edit-project-save"
            onClick={save}
            className="rounded-md bg-brand px-3 py-1.5 font-medium text-brand-foreground text-sm transition-colors hover:bg-brand/90"
          >
            {t("Save")}
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
    </div>
  )
}
