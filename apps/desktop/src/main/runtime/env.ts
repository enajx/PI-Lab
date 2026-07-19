/**
 * Runtime environment + testability hooks (md/engineering/testing-and-build.md). These are the only
 * knobs an automated harness needs to drive the app headless against a throwaway
 * data dir, so they're read once and shared.
 */

/** True under `electron-vite dev` (renderer served from the Vite dev server). */
export const isDev = process.env.NODE_ENV === "development"

/**
 * Test mode (`PI_LAB_TEST_MODE=1`) relaxes interactive behavior so the smoke
 * harness can run many instances in parallel and assert deterministically:
 * single-instance lock is skipped and auto-update/telemetry stay off (neither
 * exists yet — this just reserves the seam).
 */
export const isTestMode = process.env.PI_LAB_TEST_MODE === "1"

/**
 * Let one dedicated Electron spec exercise the real SQLite first-run decision.
 * Other test-mode launches bypass setup so existing fresh-data suites keep
 * testing their intended surface.
 */
export const testFirstRun = isTestMode && process.env.PI_LAB_TEST_FIRST_RUN === "1"

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

/** Vite renderer dev-server URL, injected by electron-vite in `dev`. */
export const rendererDevServerUrl = process.env.ELECTRON_RENDERER_URL
