import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { resolve } from "node:path"
import {
  type FileStat,
  readTextSnapshot,
  statFile,
  type TextSnapshot,
  verifyWrittenText,
} from "@pi-lab/workspace-fs"
import type { QuickEditSaveResult, QuickEditTarget } from "../../shared/quickEdit"

/** Main-owned capabilities for files selected by the OS or command line. */
export class QuickEditFiles {
  private readonly targets = new Map<string, QuickEditTarget>()
  private readonly paths = new Map<string, string>()
  private readonly baselineContent = new Map<string, string>()
  private currentId: string | null = null

  register(path: string): QuickEditTarget {
    const target = { id: randomUUID(), path: resolve(path) }
    this.paths.set(target.id, realpathSync(target.path))
    this.targets.set(target.id, target)
    this.currentId = target.id
    return target
  }

  current(): QuickEditTarget | null {
    return this.currentId ? (this.targets.get(this.currentId) ?? null) : null
  }

  /** Revoke a closed file and forget it as the active quick-edit target. */
  close(id: string): void {
    this.require(id)
    this.targets.delete(id)
    this.paths.delete(id)
    this.baselineContent.delete(id)
    if (this.currentId === id) this.currentId = null
  }

  require(id: string): QuickEditTarget {
    const target = this.targets.get(id)
    if (!target) throw new Error("Unknown quick-edit file")
    return target
  }

  private resolvedPath(id: string): string {
    this.require(id)
    const path = this.paths.get(id)
    if (!path) throw new Error("Unknown quick-edit file")
    return path
  }

  async read(id: string): Promise<TextSnapshot> {
    const snapshot = await readTextSnapshot(this.resolvedPath(id))
    if (snapshot.status === "text") this.baselineContent.set(id, snapshot.content)
    return snapshot
  }

  async stat(id: string): Promise<FileStat> {
    return statFile(this.resolvedPath(id))
  }

  async save(
    id: string,
    content: string,
    expectedBaseline: FileStat,
    overwrite: boolean,
  ): Promise<QuickEditSaveResult> {
    const path = this.resolvedPath(id)
    const actual = await statFile(path)
    if (!overwrite && !sameStat(actual, expectedBaseline)) {
      return { status: "conflict", baseline: actual }
    }
    if (!actual.exists) throw new Error("The file no longer exists")
    if (!overwrite) {
      const priorContent = this.baselineContent.get(id)
      if (priorContent === undefined) throw new Error("Read the file before saving")
      const unchanged = await verifyWrittenText(path, priorContent)
      if (!unchanged.matchesWrittenContent) {
        return { status: "conflict", baseline: unchanged.baseline }
      }
    }
    const pathInfo = await lstat(path)
    if (!pathInfo.isFile()) throw new Error("The file path is no longer a regular file")
    const handle = await open(path, "r+")
    try {
      const opened = await handle.stat()
      if (opened.dev !== pathInfo.dev || opened.ino !== pathInfo.ino) {
        throw new Error("The file was replaced while saving")
      }
      const openedBaseline = { exists: true, mtimeMs: opened.mtimeMs, size: opened.size }
      if (!overwrite && !sameStat(openedBaseline, expectedBaseline)) {
        return { status: "conflict", baseline: openedBaseline }
      }
      await handle.truncate(0)
      await handle.writeFile(content, "utf8")
    } finally {
      await handle.close()
    }
    const verified = await verifyWrittenText(path, content)
    if (!verified.matchesWrittenContent) throw new Error("Saved file differs from editor content")
    this.baselineContent.set(id, content)
    return { status: "saved", baseline: verified.baseline }
  }
}

function sameStat(first: FileStat, second: FileStat): boolean {
  return (
    first.exists === second.exists && first.size === second.size && first.mtimeMs === second.mtimeMs
  )
}
