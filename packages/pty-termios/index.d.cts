/**
 * Read terminal flags of a PTY through termios (macOS and Linux only).
 * Windows has no termios: the addon is not built there, so do not require
 * this package on win32.
 */
declare const termios: {
  /**
   * The ECHO and ICANON bits of the termios `c_lflag` of `fd` (for example a
   * PTY master fd), from one `tcgetattr` call. Throws a TypeError when `fd` is
   * not a number, and an Error with the system message when `tcgetattr` fails.
   */
  localFlags(fd: number): { echo: boolean; icanon: boolean }
}
export = termios
