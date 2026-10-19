import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { resolveDataDir } from "@pi-lab/local-db"

/** The user-editable project template under the app data directory. */
export function resolveWritableTemplateDir(): string {
  return join(resolveDataDir(), "template")
}

/** Create an empty template on first use without changing existing user files. */
export async function seedWritableTemplate(): Promise<void> {
  await mkdir(resolveWritableTemplateDir(), { recursive: true })
}
