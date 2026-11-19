// PCM sent to the server while the user speaks: fixed-size chunks numbered
// from 0, each as base64 (tRPC calls carry JSON).

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/** Standard base64 with padding (Hermes has no Buffer). */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    parts.push(
      ALPHABET.charAt(n >> 18) +
        ALPHABET.charAt((n >> 12) & 63) +
        ALPHABET.charAt((n >> 6) & 63) +
        ALPHABET.charAt(n & 63),
    )
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16
    parts.push(`${ALPHABET.charAt(n >> 18)}${ALPHABET.charAt((n >> 12) & 63)}==`)
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8)
    parts.push(
      `${ALPHABET.charAt(n >> 18)}${ALPHABET.charAt((n >> 12) & 63)}${ALPHABET.charAt((n >> 6) & 63)}=`,
    )
  }
  return parts.join("")
}

export interface PcmChunk {
  seq: number
  bytes: Uint8Array
}

/** Collects PCM buffers of any size and hands out chunks of `chunkBytes`. */
export class PcmChunker {
  private pending = new Uint8Array(0)
  private seq = 0

  constructor(private readonly chunkBytes: number) {}

  /** Add captured bytes; returns the chunks that are now full. */
  push(bytes: Uint8Array): PcmChunk[] {
    const joined = new Uint8Array(this.pending.length + bytes.length)
    joined.set(this.pending)
    joined.set(bytes, this.pending.length)
    const chunks: PcmChunk[] = []
    let offset = 0
    while (joined.length - offset >= this.chunkBytes) {
      chunks.push({ seq: this.seq, bytes: joined.slice(offset, offset + this.chunkBytes) })
      this.seq += 1
      offset += this.chunkBytes
    }
    this.pending = joined.slice(offset)
    return chunks
  }

  /** The last chunk: what is left (may be empty). */
  finish(): PcmChunk {
    const last = { seq: this.seq, bytes: this.pending }
    this.seq += 1
    this.pending = new Uint8Array(0)
    return last
  }
}
