#!/usr/bin/env node
// @ts-check
/**
 * Ensure better-sqlite3 is on the *Electron* ABI the app needs (packaged or `dev`),
 * flipping it off the Node ABI that `bun install` prebuilds — the inverse of
 * `restore-native-node.cjs`.
 *
 * Cache-aware (see native-abi.cjs): a no-op when already on the Electron ABI, a fast
 * file-copy when the Electron binary is cached, and only a one-time `@electron/rebuild`
 * compile when neither holds. Called by `package` / `package:prod`, CI's Electron-ABI
 * job, and the desktop `dev` script.
 *
 * node-pty is N-API (ABI-stable across Node and Electron), so only better-sqlite3 is
 * flipped here.
 */

require("./native-abi.cjs").ensureAbi("electron")
