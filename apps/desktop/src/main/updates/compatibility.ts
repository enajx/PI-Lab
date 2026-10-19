/** The data formats the running app has used and a candidate release can read. */
export interface DataCompatibility {
  formatVersion: number
  migrations: Array<{ hash: string; createdAt: number }>
}

/** Validate public feed metadata before it can authorize replacement of this app. */
function readCompatibility(value: unknown): DataCompatibility | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Record<string, unknown>
  if (!Number.isSafeInteger(candidate.formatVersion) || Number(candidate.formatVersion) < 1) {
    return null
  }
  if (!Array.isArray(candidate.migrations)) return null
  const migrations: DataCompatibility["migrations"] = []
  for (const entry of candidate.migrations) {
    if (!entry || typeof entry !== "object") return null
    const migration = entry as Record<string, unknown>
    if (
      typeof migration.hash !== "string" ||
      migration.hash.length === 0 ||
      !Number.isSafeInteger(migration.createdAt) ||
      Number(migration.createdAt) < 1
    ) {
      return null
    }
    migrations.push({ hash: migration.hash, createdAt: Number(migration.createdAt) })
  }
  return { formatVersion: Number(candidate.formatVersion), migrations }
}

/** Return a reason to wait, or null when the candidate can read current data. */
export function assessReleaseCompatibility(
  current: DataCompatibility,
  candidate: unknown,
): string | null {
  const release = readCompatibility(candidate)
  if (!release) return "The update is missing valid data compatibility metadata."
  if (release.formatVersion < current.formatVersion) {
    return "The update cannot read this PI Lab data format yet."
  }
  if (
    current.migrations.length > release.migrations.length ||
    current.migrations.some((migration, index) => {
      const expected = release.migrations[index]
      return migration.hash !== expected?.hash || migration.createdAt !== expected.createdAt
    })
  ) {
    return "The update does not include this PI Lab database migration history yet."
  }
  return null
}
