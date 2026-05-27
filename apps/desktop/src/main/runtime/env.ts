/**
 * Runtime environment + testability hooks (AGENTS.md §14). These are the only
 * knobs an automated harness needs to drive the app headless against a throwaway
 * data dir, so they're read once and shared.
 */

/** True under `electron-vite dev` (renderer served from the Vite dev server). */
export const isDev = process.env.NODE_ENV === "development"

/**
 * Test mode (`SKIPPER_TEST_MODE=1`) relaxes interactive behavior so the smoke
 * harness can run many instances in parallel and assert deterministically:
 * single-instance lock is skipped and auto-update/telemetry stay off (neither
 * exists yet — this just reserves the seam).
 */
export const isTestMode = process.env.SKIPPER_TEST_MODE === "1"

/**
 * Override for Skipper's on-disk state root (DB, future caches). Set BEFORE any
 * disk/DB access via `app.setPath("userData", …)`. `@skipper/local-db` reads the
 * same variable to derive the DB path, so the two always agree.
 */
export const dataDirOverride = process.env.SKIPPER_DATA_DIR?.trim() || undefined

/** Vite renderer dev-server URL, injected by electron-vite in `dev`. */
export const rendererDevServerUrl = process.env.ELECTRON_RENDERER_URL
