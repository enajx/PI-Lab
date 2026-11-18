/**
 * The last `capacity` raw PTY bytes and their absolute offsets (bytes since
 * spawn). Chunks are kept as appended and joined only when a client asks.
 */
export class ByteTail {
  private chunks: Buffer[] = []
  private head = 0
  private retained = 0
  private total = 0

  constructor(private readonly capacity: number) {}

  /** Offset of the oldest retained byte. */
  get start(): number {
    return this.total - this.retained
  }

  /** Offset just after the newest byte (the count of bytes ever appended). */
  get end(): number {
    return this.total
  }

  append(chunk: Buffer): void {
    this.total += chunk.length
    if (this.capacity === 0 || chunk.length === 0) return
    if (chunk.length >= this.capacity) {
      this.chunks = [chunk.subarray(chunk.length - this.capacity)]
      this.head = 0
      this.retained = this.capacity
      return
    }
    this.chunks.push(chunk)
    this.retained += chunk.length
    while (this.retained > this.capacity) {
      const first = this.chunks[this.head]
      if (first === undefined) break
      const removed = Math.min(first.length, this.retained - this.capacity)
      if (removed < first.length) this.chunks[this.head] = first.subarray(removed)
      else {
        this.chunks[this.head] = Buffer.alloc(0)
        this.head += 1
      }
      this.retained -= removed
    }
    if (this.head >= 1024 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head)
      this.head = 0
    }
  }

  /** The bytes from `offset` to the end, or null when `offset` is not retained. */
  from(offset: number): Buffer | null {
    if (offset < this.start || offset > this.end) return null
    const all = Buffer.concat(this.chunks.slice(this.head))
    return all.subarray(offset - this.start)
  }
}
