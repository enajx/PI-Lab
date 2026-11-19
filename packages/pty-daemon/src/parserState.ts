// Byte-level tracker of where a terminal parser stands, so the daemon knows the
// offsets at which a screen snapshot is safe: the parser is in its ground state
// and no UTF-8 character is half read. The states and exits follow the VT500
// parser as implemented by xterm.js (EscapeSequenceParser), including C1
// controls, which xterm reads from decoded code points (U+0080 to U+009F).

enum State {
  Ground,
  Escape,
  EscapeIntermediate,
  Csi,
  Osc,
  /** DCS, SOS, PM and APC: all end only on ST, CAN, SUB, ESC or a C1 control. */
  String,
}

export class ParserTracker {
  private state = State.Ground
  /** Continuation bytes still needed for the current UTF-8 character. */
  private utf8Needed = 0
  /** Bits of a two-byte UTF-8 character, kept to spot encoded C1 controls. */
  private utf8Lead = 0

  /** True when a snapshot taken now contains no half-read sequence or character. */
  get safe(): boolean {
    return this.state === State.Ground && this.utf8Needed === 0
  }

  /** Forget any partial sequence, as after a CAN sent to the emulator. */
  reset(): void {
    this.state = State.Ground
    this.utf8Needed = 0
  }

  /**
   * Feed `bytes` and return the index just after the last byte that left the
   * tracker safe, or -1 when no position in `bytes` is safe.
   */
  pushAndFindLastSafe(bytes: Uint8Array): number {
    let lastSafe = -1
    for (let index = 0; index < bytes.length; index++) {
      this.pushByte(bytes[index] as number)
      if (this.safe) lastSafe = index + 1
    }
    return lastSafe
  }

  private pushByte(byte: number): void {
    if (this.utf8Needed > 0) {
      if ((byte & 0xc0) === 0x80) {
        this.utf8Needed -= 1
        if (this.utf8Needed === 0) {
          // Only two-byte characters can be C1 controls; longer ones are printable.
          const codePoint = this.utf8Lead === 0 ? 0xa0 : (this.utf8Lead << 6) | (byte & 0x3f)
          this.pushCodePoint(codePoint)
        }
        return
      }
      // A broken character is dropped and this byte starts over.
      this.utf8Needed = 0
    }
    if (byte < 0x80) this.pushCodePoint(byte)
    else if (byte >= 0xc0 && byte < 0xe0) {
      this.utf8Needed = 1
      this.utf8Lead = byte & 0x1f
    } else if (byte >= 0xe0 && byte < 0xf0) {
      this.utf8Needed = 2
      this.utf8Lead = 0
    } else if (byte >= 0xf0 && byte < 0xf8) {
      this.utf8Needed = 3
      this.utf8Lead = 0
    }
    // Stray continuation bytes and 0xF8 to 0xFF are ignored, as by the decoder.
  }

  private pushCodePoint(code: number): void {
    // Transitions from any state.
    if (code === 0x18 || code === 0x1a) {
      this.state = State.Ground
      return
    }
    if (code === 0x1b) {
      this.state = State.Escape
      return
    }
    if (code >= 0x80 && code <= 0x9f) {
      if (code === 0x9b) this.state = State.Csi
      else if (code === 0x9d) this.state = State.Osc
      else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f)
        this.state = State.String
      else this.state = State.Ground
      return
    }
    // xterm's table sends a non-ASCII code point inside ESC and CSI to ground (error).
    if (code >= 0xa0 && this.state !== State.Osc && this.state !== State.String) {
      this.state = State.Ground
      return
    }
    switch (this.state) {
      case State.Ground:
      case State.String:
        return
      case State.Escape:
        if (code >= 0x20 && code <= 0x2f) this.state = State.EscapeIntermediate
        else if (code === 0x5b) this.state = State.Csi
        else if (code === 0x5d) this.state = State.Osc
        else if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f)
          this.state = State.String
        else if (code >= 0x30 && code <= 0x7e) this.state = State.Ground
        return
      case State.EscapeIntermediate:
        if (code >= 0x30 && code <= 0x7e) this.state = State.Ground
        return
      case State.Csi:
        if (code >= 0x40 && code <= 0x7e) this.state = State.Ground
        return
      case State.Osc:
        if (code === 0x07) this.state = State.Ground
        return
    }
  }
}
