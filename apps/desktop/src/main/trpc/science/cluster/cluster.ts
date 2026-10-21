import { type Machine, machines, type NewMachine, type PiLabDatabase } from "@pi-lab/local-db"
import { TRPCError } from "@trpc/server"
import { asc, eq } from "drizzle-orm"
import { z } from "zod"
import { withMeaningfulActivity } from "../../../caffeine"
import {
  defaultSshConfigPath,
  type GpuSnapshot,
  readSshConfig,
  type SshExec,
} from "../../../lib/ssh-config"
import { publicProcedure, router } from "../../trpc"

/**
 * Cluster science tab — v1 is **monitoring only**:
 * import compute boxes from `~/.ssh/config`, add a few by hand, annotate / hide
 * them, and probe reachability over the `ssh` CLI. Job dispatch and experiment
 * runs are explicitly v2 and have no procedures here.
 *
 * The router is thin: each procedure validates input, touches the injected
 * Drizzle handle (and, for status, the injected {@link AppContext.sshExec}), and
 * returns rows — no orchestration, no cloud. Connection metadata only; ssh key
 * material is never read or stored (see the ssh-config parser).
 */

/** Shape returned by {@link listInput}: machines plus the hidden tally for the UI. */
export interface MachineListResult {
  machines: Machine[]
  /** Count of hidden machines, so the tab can render "Show hidden (N)". */
  hiddenCount: number
}

/**
 * What a probe returns to the UI: the persisted machine row (with its refreshed
 * reachability) plus the **transient** telemetry collected this probe. The
 * telemetry is deliberately not on the row — it's point-in-time and ages
 * immediately, so the DB keeps only reachability and the renderer holds the
 * telemetry in component state keyed by host.
 */
export interface MachineProbeResult {
  machine: Machine
  /** Per-GPU usage when reachable; empty array when reachable but no GPUs; undefined when unreachable. */
  gpus?: GpuSnapshot[]
  /** Overall CPU-busy percentage (0–100) when it could be read. */
  cpuUsage?: number
}

const idInput = z.object({ id: z.string().min(1) })

const importInput = z.object({
  /** ssh config to import; defaults to `~/.ssh/config`. Explicit for tests. */
  path: z.string().min(1).optional(),
})

const addInput = z.object({
  host: z
    .string()
    .trim()
    .min(1)
    .refine((host) => !host.startsWith("-"), "SSH host must not start with '-'"),
  hostname: z.string().optional(),
  user: z.string().optional(),
  port: z.number().int().positive().optional(),
  label: z.string().optional(),
})

const updateInput = z.object({
  id: z.string().min(1),
  hostname: z.string().nullable().optional(),
  user: z.string().nullable().optional(),
  port: z.number().int().positive().nullable().optional(),
  label: z.string().nullable().optional(),
})

const listInput = z
  .object({
    /** Include hidden machines in `machines` (the tally is always full). */
    includeHidden: z.boolean().optional(),
  })
  .optional()

const setHiddenInput = z.object({ id: z.string().min(1), hidden: z.boolean() })

const annotateInput = z.object({
  id: z.string().min(1),
  /** Free-text label, or `null` to clear it. */
  label: z.string().nullable(),
})

/** Empty / whitespace-only optional strings collapse to undefined (no blank rows). */
function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

export const clusterRouter = router({
  /**
   * Import hosts from an OpenSSH client config (default `~/.ssh/config`) into the
   * `machines` table as `source: "ssh-config"` rows. Upserts by `host` so a
   * re-import refreshes connection metadata in place rather than duplicating —
   * and preserves the user's local annotations (label, hidden) across re-imports.
   * Returns the number imported (inserted + refreshed).
   */
  importFromSshConfig: publicProcedure
    .input(importInput)
    .mutation(async ({ ctx, input }): Promise<{ imported: number }> => {
      const path = input?.path ?? defaultSshConfigPath()
      const hosts = await readSshConfig(path)
      const now = Date.now()

      for (const entry of hosts) {
        const values: NewMachine = {
          host: entry.alias,
          hostname: entry.hostname ?? null,
          user: entry.user ?? null,
          port: entry.port ?? null,
          source: "ssh-config",
          updatedAt: now,
        }
        // Upsert on the unique `host`. Local-only fields (hidden, label, status)
        // are deliberately NOT overwritten — a re-import must not undo the user's
        // annotations or re-show a host they hid.
        ctx.db
          .insert(machines)
          .values(values)
          .onConflictDoUpdate({
            target: machines.host,
            set: {
              hostname: values.hostname,
              user: values.user,
              port: values.port,
              source: "ssh-config",
              updatedAt: now,
            },
          })
          .run()
      }

      return { imported: hosts.length }
    }),

  /**
   * Register a machine by hand (`source: "manual"`) for a box that isn't in ssh
   * config. The `host` is what `ssh` is invoked with; it must be unique.
   */
  addMachine: publicProcedure.input(addInput).mutation(({ ctx, input }): Machine => {
    const existing = ctx.db.select().from(machines).where(eq(machines.host, input.host)).get()
    if (existing) {
      throw new TRPCError({ code: "CONFLICT", message: `Machine already exists: ${input.host}` })
    }
    return ctx.db
      .insert(machines)
      .values({
        host: input.host.trim(),
        hostname: clean(input.hostname) ?? null,
        user: clean(input.user) ?? null,
        port: input.port ?? null,
        label: clean(input.label) ?? null,
        source: "manual",
      })
      .returning()
      .get()
  }),

  /** Update a manual machine's connection metadata / label (partial patch). */
  updateMachine: publicProcedure.input(updateInput).mutation(({ ctx, input }): Machine => {
    const patch: Partial<NewMachine> = { updatedAt: Date.now() }
    if (input.hostname !== undefined) patch.hostname = clean(input.hostname ?? undefined) ?? null
    if (input.user !== undefined) patch.user = clean(input.user ?? undefined) ?? null
    if (input.port !== undefined) patch.port = input.port
    if (input.label !== undefined) patch.label = clean(input.label ?? undefined) ?? null

    const row = ctx.db
      .update(machines)
      .set(patch)
      .where(eq(machines.id, input.id))
      .returning()
      .get()
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: `No machine ${input.id}` })
    return row
  }),

  /**
   * Hide / unhide a machine. Hidden rows are filtered from the default list
   * (ssh-config often holds git hosts / jump boxes), never deleted.
   */
  setHidden: publicProcedure.input(setHiddenInput).mutation(({ ctx, input }): Machine => {
    const row = ctx.db
      .update(machines)
      .set({ hidden: input.hidden, updatedAt: Date.now() })
      .where(eq(machines.id, input.id))
      .returning()
      .get()
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: `No machine ${input.id}` })
    return row
  }),

  /** Set (or clear, with `label: null`) a machine's free-text annotation. */
  annotate: publicProcedure.input(annotateInput).mutation(({ ctx, input }): Machine => {
    const row = ctx.db
      .update(machines)
      .set({ label: clean(input.label ?? undefined) ?? null, updatedAt: Date.now() })
      .where(eq(machines.id, input.id))
      .returning()
      .get()
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: `No machine ${input.id}` })
    return row
  }),

  /**
   * List machines (hidden excluded by default), alphabetized by host, with the
   * full hidden tally so the tab can offer "Show hidden (N)".
   */
  list: publicProcedure.input(listInput).query(({ ctx, input }): MachineListResult => {
    const all = ctx.db.select().from(machines).orderBy(asc(machines.host)).all()
    const hiddenCount = all.reduce((n, m) => (m.hidden ? n + 1 : n), 0)
    const visible = input?.includeHidden ? all : all.filter((m) => !m.hidden)
    return { machines: visible, hiddenCount }
  }),

  /**
   * Probe one machine over the injected `ssh` exec: persist the reachability on
   * the row and return it together with this probe's transient GPU / CPU
   * telemetry. Never throws on an unreachable host — that's a normal recorded
   * outcome (`reachable: false` + a detail), not an error.
   */
  refreshStatus: publicProcedure
    .input(idInput)
    .mutation(async ({ ctx, input }): Promise<MachineProbeResult> => {
      const machine = ctx.db.select().from(machines).where(eq(machines.id, input.id)).get()
      if (!machine) throw new TRPCError({ code: "NOT_FOUND", message: `No machine ${input.id}` })
      return withMeaningfulActivity(ctx.caffeine, `cluster:refresh:${machine.id}`, async () =>
        probeAndRecord(ctx.db, ctx.sshExec, machine),
      )
    }),

  /**
   * Probe every non-hidden machine concurrently, persist each reachability, and
   * return the refreshed rows with their per-probe telemetry (hidden machines are
   * left untouched).
   */
  refreshAll: publicProcedure.mutation(async ({ ctx }): Promise<MachineProbeResult[]> => {
    const targets = ctx.db.select().from(machines).where(eq(machines.hidden, false)).all()
    return withMeaningfulActivity(ctx.caffeine, "cluster:refresh-all", async () =>
      Promise.all(targets.map((m) => probeAndRecord(ctx.db, ctx.sshExec, m))),
    )
  }),
})

/**
 * Probe a single machine, write only the (persisted) reachability back to its
 * row, and return that row alongside this probe's transient telemetry. Factored
 * out so `refreshStatus` and `refreshAll` share one code path (and one place to
 * evolve the probe contract). Telemetry is never written to the DB — it is
 * point-in-time and surfaced through the return value only.
 */
async function probeAndRecord(
  db: PiLabDatabase,
  sshExec: SshExec,
  machine: Machine,
): Promise<MachineProbeResult> {
  const result = await sshExec(machine)
  const row = db
    .update(machines)
    .set({
      reachable: result.ok,
      statusDetail: result.detail,
      lastCheckedAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(machines.id, machine.id))
    .returning()
    .get()
  return { machine: row, gpus: result.gpus, cpuUsage: result.cpuUsage }
}
