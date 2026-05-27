const DEFAULT_FALLBACK = "untitled"
const DEFAULT_MAX_LENGTH = 60

export interface SlugifyOptions {
  /** Returned when the input reduces to an empty slug. Default `"untitled"`. */
  fallback?: string
  /** Maximum length of the result before the fallback applies. Default `60`. */
  maxLength?: number
}

/**
 * Convert arbitrary text into a lowercase, hyphen-separated slug containing only
 * `[a-z0-9-]`, with no leading, trailing, or consecutive hyphens. Used to derive
 * safe workspace and git-branch names from user-entered titles.
 *
 * Accented Latin folds to its base letter ("Über Café" -> "uber-cafe"); other
 * non-ASCII scripts have no slug form and fall back.
 *
 * Guarantees (covered by property tests):
 *   - **Total** — never throws for any string input.
 *   - **Clean shape** — always matches `^[a-z0-9]+(-[a-z0-9]+)*$`.
 *   - **Idempotent** — `slugify(slugify(x)) === slugify(x)`.
 *   - **Bounded** — result length ≤ `maxLength`.
 */
export function slugify(input: string, options: SlugifyOptions = {}): string {
  const fallback = options.fallback ?? DEFAULT_FALLBACK
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH

  const slug = input
    // Decompose accents to "base + combining mark", then drop everything
    // non-ASCII (the combining marks, emoji, non-Latin scripts).
    .normalize("NFKD")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ASCII range is the intent
    .replace(/[^\x00-\x7f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // collapse runs of non-alphanumerics to one hyphen
    .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
    .slice(0, maxLength)
    .replace(/-+$/g, "") // re-trim if the slice landed on a hyphen boundary

  return slug.length > 0 ? slug : fallback
}
