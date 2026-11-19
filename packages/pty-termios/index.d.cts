/**
 * Read and set terminal flags of a PTY through termios (macOS and Linux only).
 * Windows has no termios: the addon is not built there and the package
 * exports null.
 */
declare const termios: {
  /**
   * The ECHO and ICANON bits of the termios `c_lflag` of `fd` (for example a
   * PTY master fd), from one `tcgetattr` call. Throws a TypeError when `fd` is
   * not a number; returns `{ error }` with the system message when `tcgetattr` fails.
   */
  localFlags(fd: number): { echo: boolean; icanon: boolean } | { error: string }
  /**
   * Turn on IUTF8 in the termios `c_iflag` of `fd` (`tcgetattr`, then
   * `tcsetattr`). Throws a TypeError when `fd` is not a number; returns the
   * system message when a call fails, null on success.
   */
  setUtf8(fd: number): string | null
} | null
export = termios
