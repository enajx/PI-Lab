/**
 * Runtime environment + testability hooks. These are the only
 * knobs an automated harness needs to drive the app headless against a throwaway
 * data dir, so they're read once and shared.
 */

/** True under `electron-vite dev` (renderer served from the Vite dev server). */
export const isDev = process.env.NODE_ENV === "development"

/**
 * Test mode (`PI_LAB_TEST_MODE=1`) relaxes interactive behavior so the smoke
 * harness can run many instances in parallel and assert deterministically:
 * single-instance lock is skipped and public auto-update stays off.
 */
export const isTestMode = process.env.PI_LAB_TEST_MODE === "1"

/**
 * Let one dedicated Electron spec exercise the real SQLite first-run decision.
 * Other test-mode launches bypass setup so existing fresh-data suites keep
 * testing their intended surface.
 */
export const testFirstRun = isTestMode && process.env.PI_LAB_TEST_FIRST_RUN === "1"

/**
 * Opt-out of the test-mode dialog responder (runtime/testDialogs.ts): with
 * `PI_LAB_TEST_NATIVE_DIALOGS=1` a test-mode app shows real native dialogs, for
 * the scripted macOS Accessibility tests that click them.
 */
export const testNativeDialogs = isTestMode && process.env.PI_LAB_TEST_NATIVE_DIALOGS === "1"

/**
 * Override for PI Lab's on-disk state root (DB, future caches). Set BEFORE any
 * disk/DB access via `app.setPath("userData", …)`. `@pi-lab/local-db` reads the
 * same variable to derive the DB path, so the two always agree.
 */
export const dataDirOverride = process.env.PI_LAB_DATA_DIR?.trim() || undefined

/** Test-only home directory for deterministic global Skills discovery. */
export const skillsHomeDirOverride = isTestMode
  ? process.env.PI_LAB_TEST_SKILLS_HOME?.trim() || undefined
  : undefined

/**
 * Test-only: while this file exists the dictation engine's model counts as still
 * loading, so an end-to-end test can hold the loading state and release it.
 */
export const testDictationHoldHealthFile = isTestMode
  ? process.env.PI_LAB_TEST_DICTATION_HOLD_HEALTH?.trim() || undefined
  : undefined

/**
 * Test-only: while this file exists a transcription waits before it asks the
 * engine, so an end-to-end test can hold the transcribing state.
 */
export const testDictationHoldTranscribeFile = isTestMode
  ? process.env.PI_LAB_TEST_DICTATION_HOLD_TRANSCRIBE?.trim() || undefined
  : undefined

/** Test-only deterministic replacement for the native directory picker. */
export const pickDirectoryOverride = isTestMode
  ? process.env.PI_LAB_TEST_PICK_DIRECTORY?.trim() || undefined
  : undefined

/** Test-only deterministic replacement for the native save dialog (the path to save to). */
export const saveFileOverride = isTestMode
  ? process.env.PI_LAB_TEST_SAVE_FILE?.trim() || undefined
  : undefined

function readTestFontFamilies(): string[] | undefined {
  if (!isTestMode) return undefined
  const raw = process.env.PI_LAB_TEST_FONT_FAMILIES?.trim()
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return undefined
    const families = parsed.filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    )
    return families.length > 0 ? families : undefined
  } catch {
    return undefined
  }
}

/** Test-only system-font result, keeping Electron UI tests independent of host fonts. */
export const testFontFamilies = readTestFontFamilies()

/** Vite renderer dev-server URL, injected by electron-vite in `dev`. */
export const rendererDevServerUrl = process.env.ELECTRON_RENDERER_URL
