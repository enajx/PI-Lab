#!/usr/bin/env node
// @ts-check
/**
 * Ensure better-sqlite3 is on the *Node* ABI that `bun run test` (Vitest under
 * plain Node) needs — the inverse of `rebuild-native-electron.cjs`.
 *
 * Cache-aware (see native-abi.cjs): a no-op when already on the Node ABI, a fast
 * file-copy when the Node binary is cached, and only a one-time `prebuild-install`
 * download when neither holds. Wired into the root `test` / `test:watch` scripts so
 * running the suite after building/launching the Electron app just works.
 */

require("./native-abi.cjs").ensureAbi("node")
