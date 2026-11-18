/**
 * How one approved quit treats running work. The PI Lab server keeps agents
 * and terminals running after the app quits, so no mode stops them here:
 * - `end`: explicit Quit (Cmd+Q, menu, tray, last-window close), already confirmed;
 * - `confirm-end`: any other quit, such as macOS logout or shutdown, which also
 *   ends the user's server; ask first while work runs;
 * - `keep`: Restart to Update.
 */
export type QuitMode = "end" | "confirm-end" | "keep"
