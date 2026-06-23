/**
 * Read an image `File` (dropped onto a project card) into a `data:` URL so it can
 * be persisted as the card's thumbnail (md/02 — drag-and-drop a header image).
 * Resolves `null` on a read error rather than throwing, so a bad/aborted drop is
 * a no-op for the caller. Side-effecting (uses `FileReader`), so it lives outside
 * the pure utils and is exercised via the component/E2E path, not a unit test.
 */
export function readImageFileAsDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      resolve(typeof result === "string" ? result : null)
    }
    reader.onerror = () => resolve(null)
    reader.onabort = () => resolve(null)
    reader.readAsDataURL(file)
  })
}
