/** Exact UTF-16 suffix with bounded chunks; flatten only when a client attaches. */
export class Scrollback {
  private chunks: string[] = []
  private head = 0
  private length = 0

  constructor(private readonly capacity: number) {}

  append(chunk: string): void {
    if (this.capacity === 0 || chunk.length === 0) return
    if (chunk.length >= this.capacity) {
      this.chunks = [chunk.slice(-this.capacity)]
      this.head = 0
      this.length = this.capacity
      return
    }
    this.chunks.push(chunk)
    this.length += chunk.length
    while (this.length > this.capacity) {
      const first = this.chunks[this.head]
      if (first === undefined) break
      const removed = Math.min(first.length, this.length - this.capacity)
      if (removed < first.length) this.chunks[this.head] = first.slice(removed)
      else {
        this.chunks[this.head] = ""
        this.head += 1
      }
      this.length -= removed
    }
    if (this.head >= 1024 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head)
      this.head = 0
    }
  }

  text(): string {
    return this.chunks.slice(this.head).join("")
  }
}
