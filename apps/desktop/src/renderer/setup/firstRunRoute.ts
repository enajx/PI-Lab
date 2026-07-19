export type SetupGateMode = "honor" | "bypass"

/**
 * The query value is added only by Electron main while PI_LAB_TEST_MODE=1.
 * Production receives no value and always honors SQLite.
 */
export function readSetupGateMode(search: string): SetupGateMode {
  return new URLSearchParams(search).get("setup") === "skip" ? "bypass" : "honor"
}

export function shouldRedirectToSetup(
  setupCompleted: boolean,
  pathname: string,
  mode: SetupGateMode,
): boolean {
  return pathname !== "/setup" && !setupCompleted && mode === "honor"
}
