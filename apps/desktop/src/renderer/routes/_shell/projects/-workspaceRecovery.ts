import type { SerializedDockview } from "dockview-react"
import { z } from "zod"
import type { OpenBuffer } from "../../../Editor/hooks/useEditorBuffers"
import type { CentralPanelRestoreState } from "./components/CentralPanel/useCentralPanel"

export const RECOVERY_PREFIX = "pi-lab.projectWorkspace.v2."
const CONTENT_LIMIT = 1_000_000
const STORAGE_LIMIT = 4 * 1024 * 1024

export interface OmittedBuffer {
  relPath: string
  untitled: boolean
  reason: string
}

export interface ProjectWorkspaceState extends CentralPanelRestoreState {
  workspaceId?: string
  rightSidebarCollapsed: boolean
  rightSidebarActiveId: string | null
  pinnedPanels: string[]
  /** This project's own left Files column choice; `undefined` follows the global default. */
  filesPanelOpen?: boolean
  omittedBuffers?: OmittedBuffer[]
}

/** The project-view fields saved by `writeView`; `filesPanelOpen` must be passed, even as `undefined`. */
export type ProjectWorkspaceViewState = Pick<
  ProjectWorkspaceState,
  "rightSidebarCollapsed" | "rightSidebarActiveId" | "pinnedPanels"
> & { filesPanelOpen: boolean | undefined }

export interface AffectedBuffer {
  projectId: string
  buffer: OpenBuffer
}

const bufferSchema = z.object({
  kind: z.literal("pdf").optional(),
  relPath: z.string(),
  content: z.string(),
  savedContent: z.string(),
  baseline: z.object({ mtimeMs: z.number(), size: z.number() }),
  externalChange: z.boolean(),
  epoch: z.number(),
  untitled: z.boolean().optional(),
})
const launchSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("terminal") }),
  z.object({ type: z.literal("python"), relPath: z.string() }),
  z.object({ type: z.literal("auto-research") }),
  z.object({
    type: z.literal("agent"),
    agentId: z.string(),
    workspaceMode: z.enum(["policy", "main", "worktree"]),
  }),
])
const stateSchema = z.object({
  buffers: z.array(bufferSchema),
  activeRelPath: z.string().nullable(),
  sessions: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["agent", "terminal"]),
      sessionId: z.string(),
      label: z.string(),
      wsKind: z.enum(["branch", "worktree"]).optional(),
      launch: launchSchema.optional(),
    }),
  ),
  active: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("file"), relPath: z.string() }),
      z.object({ type: z.literal("session"), id: z.string() }),
    ])
    .nullable(),
  belowEditorRun: z
    .object({ sessionId: z.string(), label: z.string(), relPath: z.string().optional() })
    .nullable(),
  /** dockview's own serialized split layout; dockview validates its contents on load. */
  layout: z
    .custom<SerializedDockview>((value) => typeof value === "object" && value !== null)
    .nullable()
    .optional(),
  workspaceId: z.string().optional(),
  rightSidebarCollapsed: z.boolean(),
  rightSidebarActiveId: z.string().nullable(),
  pinnedPanels: z.array(z.string()),
  // Absent until the project toggles its left Files column; then it overrides the global default.
  filesPanelOpen: z.boolean().optional(),
  omittedBuffers: z
    .array(z.object({ relPath: z.string(), untitled: z.boolean(), reason: z.string() }))
    .optional(),
})

/** Untitled is explicit for new buffers; the fingerprint recognizes earlier live callers. */
export function isUntitledBuffer(buffer: OpenBuffer): boolean {
  return (
    buffer.untitled === true ||
    (buffer.untitled === undefined &&
      buffer.baseline.mtimeMs === 0 &&
      buffer.baseline.size === 0 &&
      /^untitled(?:-\d+)?\.md$/i.test(buffer.relPath))
  )
}

export function isDirtyBuffer(buffer: OpenBuffer): boolean {
  return buffer.externalChange || buffer.content !== buffer.savedContent
}

function sameBuffer(left: OpenBuffer, right: OpenBuffer): boolean {
  return (
    left.relPath === right.relPath &&
    left.content === right.content &&
    left.savedContent === right.savedContent &&
    left.externalChange === right.externalChange &&
    left.baseline.mtimeMs === right.baseline.mtimeMs &&
    left.baseline.size === right.baseline.size &&
    left.untitled === right.untitled
  )
}

function summary(state: ProjectWorkspaceState | undefined): string {
  return JSON.stringify(
    state
      ? {
          files: state.buffers.map((buffer) => [buffer.relPath, isDirtyBuffer(buffer)]),
          sessions: state.sessions,
          active: state.active,
          below: state.belowEditorRun,
        }
      : null,
  )
}

/** Project-local writes with a separate record of what successfully reached storage. */
export class WorkspaceRecoveryStore {
  private readonly states = new Map<string, ProjectWorkspaceState>()
  private readonly liveProjects = new Set<string>()
  private readonly serialized = new Map<string, string>()
  private readonly successful = new Map<string, ProjectWorkspaceState>()
  private readonly failures = new Map<string, string>()
  private readonly contentChecks = new WeakMap<OpenBuffer, { content: boolean; saved: boolean }>()
  private readonly projectWarnings = new Map<string, string[]>()
  private storageReadable = true
  private readonly timers = new Map<
    string,
    { delay: ReturnType<typeof setTimeout>; max: ReturnType<typeof setTimeout> }
  >()
  private readonly listeners = new Set<() => void>()
  private readonly recoveryListeners = new Set<() => void>()
  private hydrated = false
  private warningSnapshot = ""
  private revision = 0

  constructor(private readonly storage: Storage) {}

  /** Subscribe only to sidebar-visible summary changes. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  subscribeRecovery = (listener: () => void): (() => void) => {
    this.recoveryListeners.add(listener)
    return () => {
      this.recoveryListeners.delete(listener)
    }
  }

  getRevision = (): number => this.revision

  read(projectId: string, restoreTabs: boolean): ProjectWorkspaceState | undefined {
    this.hydrate()
    const state = this.states.get(projectId)
    if (!state || restoreTabs || this.liveProjects.has(projectId)) return state
    return {
      ...state,
      buffers: [],
      omittedBuffers: [],
      activeRelPath: null,
      sessions: [],
      active: null,
      belowEditorRun: null,
      layout: null,
    }
  }

  /** Retain the latest live state immediately; only serialization is delayed. */
  write(projectId: string, state: CentralPanelRestoreState, workspaceId?: string): void {
    this.hydrate()
    const previous = this.states.get(projectId)
    const next: ProjectWorkspaceState = {
      ...state,
      workspaceId: workspaceId || previous?.workspaceId,
      rightSidebarCollapsed: previous?.rightSidebarCollapsed ?? false,
      rightSidebarActiveId: previous?.rightSidebarActiveId ?? null,
      pinnedPanels: previous?.pinnedPanels ?? [],
      filesPanelOpen: previous?.filesPanelOpen,
      omittedBuffers: (state.omittedBuffers ?? previous?.omittedBuffers ?? []).filter(
        (item) => !state.buffers.some((buffer) => buffer.relPath === item.relPath),
      ),
    }
    for (const buffer of next.buffers) {
      if (this.contentChecks.has(buffer)) continue
      const prior = previous?.buffers.find((entry) => entry.relPath === buffer.relPath)
      const checks = prior ? this.contentChecks.get(prior) : undefined
      this.contentChecks.set(buffer, {
        content:
          prior?.content === buffer.content && checks
            ? checks.content
            : this.fitsContent(buffer.content),
        saved:
          prior?.savedContent === buffer.savedContent && checks
            ? checks.saved
            : this.fitsContent(buffer.savedContent),
      })
    }
    this.liveProjects.add(projectId)
    this.states.set(projectId, next)
    this.refreshWarnings(projectId, next)
    if (summary(previous) !== summary(next)) this.notifySummary()
    this.schedule(projectId)
    this.notifyRecovery()
  }

  writeView(projectId: string, view: ProjectWorkspaceViewState): void {
    this.hydrate()
    const previous = this.states.get(projectId)
    if (!previous) return
    if (
      previous.rightSidebarCollapsed === view.rightSidebarCollapsed &&
      previous.rightSidebarActiveId === view.rightSidebarActiveId &&
      previous.pinnedPanels === view.pinnedPanels &&
      previous.filesPanelOpen === view.filesPanelOpen
    )
      return
    this.states.set(projectId, { ...previous, ...view })
    this.schedule(projectId)
  }

  /** Editor operation adapters update buffers even after their route has unmounted. */
  updateBuffers(projectId: string, update: (buffers: OpenBuffer[]) => OpenBuffer[]): void {
    const state = this.read(projectId, true)
    if (!state) return
    const buffers = update(state.buffers)
    if (buffers === state.buffers) return
    const activeRelPath = buffers.some((buffer) => buffer.relPath === state.activeRelPath)
      ? state.activeRelPath
      : (buffers.at(-1)?.relPath ?? null)
    this.write(projectId, {
      ...state,
      buffers,
      activeRelPath,
      active:
        state.active?.type === "file"
          ? activeRelPath
            ? { type: "file", relPath: activeRelPath }
            : null
          : state.active,
    })
  }

  /** Flush current snapshots before navigation or a shutdown decision. */
  flush(projectId?: string): void {
    this.hydrate()
    const ids = projectId ? [projectId] : [...this.timers.keys()]
    for (const id of ids) {
      this.cancelTimer(id)
      const state = this.states.get(id)
      if (state) this.persist(id, state)
    }
    this.notifyRecovery()
  }

  affected(recoveryEnabled: boolean): AffectedBuffer[] {
    this.hydrate()
    const affected: AffectedBuffer[] = []
    for (const [projectId, state] of this.states) {
      if (!recoveryEnabled && !this.liveProjects.has(projectId)) continue
      for (const buffer of state.buffers) {
        if (!isDirtyBuffer(buffer)) continue
        const protectedBuffer = this.successful
          .get(projectId)
          ?.buffers.find((saved) => saved.relPath === buffer.relPath)
        if (
          !recoveryEnabled ||
          !protectedBuffer ||
          !this.eligible(protectedBuffer) ||
          !sameBuffer(buffer, protectedBuffer)
        )
          affected.push({ projectId, buffer })
      }
    }
    return affected
  }

  warnings(): string[] {
    this.hydrate()
    return [...new Set([...this.failures.values(), ...[...this.projectWarnings.values()].flat()])]
  }

  private refreshWarnings(projectId: string, state: ProjectWorkspaceState): void {
    this.projectWarnings.set(projectId, [
      ...state.buffers
        .filter((buffer) => !this.eligible(buffer))
        .map(
          (buffer) =>
            `${buffer.relPath}: recovery excludes contents above 1 MB. Current edits are not protected.`,
        ),
      ...(state.omittedBuffers ?? [])
        .filter((item) => item.reason !== "Reload this file from disk.")
        .map((item) => `${item.relPath}: ${item.reason}`),
    ])
  }

  /** Delete only the affected stale drafts. Storage failure never grants shutdown. */
  discard(affected: AffectedBuffer[], onDiscarded?: (affected: AffectedBuffer[]) => void): boolean {
    this.hydrate()
    const byProject = new Map<string, AffectedBuffer[]>()
    for (const item of affected)
      byProject.set(item.projectId, [...(byProject.get(item.projectId) ?? []), item])
    for (const [projectId, items] of byProject) {
      const live = this.states.get(projectId)
      if (
        !live ||
        items.some(
          (item) =>
            live.buffers.find((buffer) => buffer.relPath === item.buffer.relPath) !== item.buffer,
        )
      )
        return false
      const paths = new Set(items.map((item) => item.buffer.relPath))
      // Base cleanup on the last successful snapshot, preserving every other protected file.
      const previous = this.successful.get(projectId) ?? live
      const kept = previous.buffers.filter((buffer) => !paths.has(buffer.relPath))
      const diskPaths = items
        .filter((item) => !isUntitledBuffer(item.buffer))
        .map((item) => ({
          relPath: item.buffer.relPath,
          untitled: false,
          reason: "Reload this file from disk.",
        }))
      const cleaned = {
        ...previous,
        buffers: kept,
        omittedBuffers: [
          ...(previous.omittedBuffers ?? []).filter((item) => !paths.has(item.relPath)),
          ...diskPaths,
        ],
      }
      if (!this.persist(projectId, cleaned)) return false
      this.cancelTimer(projectId)
      // Remove only these revisions from live state, preventing a later flush resurrecting them.
      this.states.set(projectId, {
        ...live,
        buffers: live.buffers.filter((buffer) => !paths.has(buffer.relPath)),
        omittedBuffers: cleaned.omittedBuffers,
      })
      const remaining = this.states.get(projectId)
      if (remaining) this.refreshWarnings(projectId, remaining)
      onDiscarded?.(items)
      this.notifySummary()
    }
    this.notifyRecovery()
    return true
  }

  dispose(): void {
    for (const id of this.timers.keys()) this.cancelTimer(id)
  }

  /** Count only until the limit; never allocate an encoded copy of a large document. */
  private fitsContent(content: string): boolean {
    if (content.length > CONTENT_LIMIT) return false
    let bytes = 0
    for (let index = 0; index < content.length; index++) {
      const code = content.charCodeAt(index)
      if (code < 0x80) bytes += 1
      else if (code < 0x800) bytes += 2
      else if (
        code >= 0xd800 &&
        code <= 0xdbff &&
        index + 1 < content.length &&
        content.charCodeAt(index + 1) >= 0xdc00 &&
        content.charCodeAt(index + 1) <= 0xdfff
      ) {
        bytes += 4
        index += 1
      } else bytes += 3
      if (bytes > CONTENT_LIMIT) return false
    }
    return true
  }

  private eligible(buffer: OpenBuffer): boolean {
    let checks = this.contentChecks.get(buffer)
    if (!checks) {
      checks = {
        content: this.fitsContent(buffer.content),
        saved: this.fitsContent(buffer.savedContent),
      }
      this.contentChecks.set(buffer, checks)
    }
    return checks.content && checks.saved
  }

  private hydrate(): void {
    if (this.hydrated) return
    this.hydrated = true
    try {
      for (let index = 0; index < this.storage.length; index++) {
        const key = this.storage.key(index)
        if (!key?.startsWith(RECOVERY_PREFIX)) continue
        const value = this.storage.getItem(key)
        if (value === null) continue
        const projectId = key.slice(RECOVERY_PREFIX.length)
        // Invalid entries still consume storage; their bytes always count.
        this.serialized.set(projectId, value)
        try {
          const parsed = stateSchema.safeParse(JSON.parse(value))
          if (!parsed.success) {
            this.failures.set(
              projectId,
              `Could not restore project ${projectId}: invalid recovery data.`,
            )
            continue
          }
          this.states.set(projectId, parsed.data)
          this.successful.set(projectId, parsed.data)
          this.refreshWarnings(projectId, parsed.data)
        } catch (cause) {
          this.failures.set(
            projectId,
            `Could not restore project ${projectId}: invalid recovery data. ${String(cause)}`,
          )
        }
      }
    } catch (cause) {
      this.storageReadable = false
      this.failures.set("storage", `Could not read recovery storage: ${String(cause)}`)
    }
  }

  private schedule(projectId: string): void {
    const pending = this.timers.get(projectId)
    if (pending) clearTimeout(pending.delay)
    const flush = () => this.flush(projectId)
    this.timers.set(projectId, {
      delay: setTimeout(flush, 500),
      max: pending?.max ?? setTimeout(flush, 2000),
    })
  }

  private cancelTimer(projectId: string): void {
    const pending = this.timers.get(projectId)
    if (!pending) return
    clearTimeout(pending.delay)
    clearTimeout(pending.max)
    this.timers.delete(projectId)
  }

  private persist(projectId: string, state: ProjectWorkspaceState): boolean {
    if (!this.storageReadable) return false
    const excluded = state.buffers.filter((buffer) => !this.eligible(buffer))
    const candidate = {
      ...state,
      buffers: state.buffers.filter((buffer) => !excluded.includes(buffer)),
      omittedBuffers: [
        ...(state.omittedBuffers ?? []).filter(
          (item) => !state.buffers.some((buffer) => buffer.relPath === item.relPath),
        ),
        ...excluded.map((buffer) => ({
          relPath: buffer.relPath,
          untitled: isUntitledBuffer(buffer),
          reason: "Recovery contents exceeded 1 MB and could not be restored.",
        })),
      ],
    }
    const serialized = JSON.stringify(candidate)
    if (serialized === this.serialized.get(projectId)) {
      this.failures.delete(projectId)
      return true
    }
    let bytes = 2 * (RECOVERY_PREFIX.length + projectId.length + serialized.length)
    for (const [id, previous] of this.serialized)
      if (id !== projectId) bytes += 2 * (RECOVERY_PREFIX.length + id.length + previous.length)
    if (bytes > STORAGE_LIMIT) {
      this.failures.set(
        projectId,
        `Recovery storage exceeds 4 MiB. The previous recovery snapshot was kept; current edits may not be protected.`,
      )
      return false
    }
    try {
      this.storage.setItem(`${RECOVERY_PREFIX}${projectId}`, serialized)
      this.serialized.set(projectId, serialized)
      this.successful.set(projectId, candidate)
      this.failures.delete(projectId)
      return true
    } catch (cause) {
      this.failures.set(
        projectId,
        `Could not write recovery storage. The previous recovery snapshot was kept; current edits may not be protected. ${String(cause)}`,
      )
      return false
    }
  }

  private notifySummary(): void {
    for (const listener of this.listeners) listener()
  }

  private notifyRecovery(): void {
    const snapshot = JSON.stringify(this.warnings())
    if (snapshot === this.warningSnapshot) return
    this.warningSnapshot = snapshot
    this.revision += 1
    for (const listener of this.recoveryListeners) listener()
  }
}
