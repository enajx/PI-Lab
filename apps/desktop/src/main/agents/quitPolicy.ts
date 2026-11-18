/**
 * How one approved quit treats running work:
 * - `end`: explicit Quit (Cmd+Q, menu, tray, last-window close), already confirmed; stop everything.
 * - `confirm-end`: any other quit, such as macOS logout or shutdown; ask only when
 *   agents, fetching, busy terminals or notebooks run, then stop everything.
 * - `keep`: Restart to Update; agents, shells and Python runs keep running and reattach.
 */
export type QuitMode = "end" | "confirm-end" | "keep"
