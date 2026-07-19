// Pure port-range allocation. Each workspace ("slot") is handed a contiguous,
// non-overlapping block of dev-server ports so concurrent workspaces never
// collide. No I/O lives here — this is deterministic arithmetic, exercised by
// property-based tests (md/engineering/testing-and-build.md).

/** Tunable bounds for slot-to-range allocation. Defaults target the high
 *  ephemeral-but-uncommon range so they rarely clash with real dev servers. */
export interface AllocationOptions {
  /** First port of slot 0. Default 30000. */
  base?: number
  /** Number of ports in every block. Default 10. */
  size?: number
  /** Highest port any block may include. Default 65535. */
  max?: number
}

/** Inclusive port range owned by a slot: ports `start..end`. */
export interface PortRange {
  start: number
  end: number
}

const DEFAULT_BASE = 30000
const DEFAULT_SIZE = 10
const DEFAULT_MAX = 65535

/** Largest valid TCP port; nothing may be allocated above it. */
const PORT_CEILING = 65535

interface ResolvedOptions {
  base: number
  size: number
  max: number
}

function resolveOptions(options: AllocationOptions | undefined): ResolvedOptions {
  const base = options?.base ?? DEFAULT_BASE
  const size = options?.size ?? DEFAULT_SIZE
  const max = options?.max ?? DEFAULT_MAX

  if (!Number.isInteger(base) || base < 1) {
    throw new RangeError(`base must be a positive integer port, got ${base}`)
  }
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`size must be a positive integer, got ${size}`)
  }
  if (!Number.isInteger(max) || max < 1 || max > PORT_CEILING) {
    throw new RangeError(`max must be an integer in 1..${PORT_CEILING}, got ${max}`)
  }
  if (base > max) {
    throw new RangeError(`base (${base}) must not exceed max (${max})`)
  }

  return { base, size, max }
}

function assertSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 0) {
    throw new RangeError(`slot must be a non-negative integer, got ${slot}`)
  }
}

/**
 * Resolve the inclusive port range owned by `slot`.
 *
 * Slots are laid out back to back from `base`: slot 0 → `base..base+size-1`,
 * slot 1 → the next `size` ports, and so on. The range is guaranteed to fit
 * within `[base, max]`; a slot whose block would spill past `max` throws so the
 * caller learns it has run out of allocatable ports rather than handing out an
 * invalid port.
 */
export function portRangeForSlot(slot: number, options?: AllocationOptions): PortRange {
  assertSlot(slot)
  const { base, size, max } = resolveOptions(options)

  const start = base + slot * size
  const end = start + size - 1

  if (end > max) {
    throw new RangeError(`slot ${slot} (ports ${start}..${end}) exceeds the maximum port ${max}`)
  }

  return { start, end }
}

/** The first port of a slot's range — the canonical port to advertise for it. */
export function portBaseForSlot(slot: number, options?: AllocationOptions): number {
  return portRangeForSlot(slot, options).start
}
