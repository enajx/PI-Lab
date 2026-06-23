#!/usr/bin/env bun
/**
 * Generate electron-builder app icons from the brand asset `icons/icon.png`
 * (AGENTS.md §13 — "generate the app icon from `icons/`").
 *
 * Outputs into `apps/desktop/build/`:
 *   - `icon.png`  — 1024×1024 master, used directly for Linux + as electron-builder's
 *                   source for Windows `.ico` generation.
 *   - `icon.icns` — macOS icon set, built via the native `iconutil` toolchain.
 *
 * macOS `.icns` is produced with `sips` + `iconutil` (present on every macOS host
 * and CI runner). On non-macOS hosts we only emit `icon.png`; electron-builder
 * derives the platform icon it needs from it at pack time.
 */

import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = resolve(HERE, "..")
const REPO_ROOT = resolve(DESKTOP_DIR, "..", "..")
const SOURCE = join(REPO_ROOT, "icons", "icon.png")
const BUILD_DIR = join(DESKTOP_DIR, "build")

function sips(args: string[]): void {
  execFileSync("sips", args, { stdio: "ignore" })
}

/** Build `build/icon.icns` from the 1024px master via sips + iconutil. */
function buildIcns(masterPng: string): void {
  const iconset = `${mkdtempSync(join(tmpdir(), "skipper-iconset-"))}.iconset`
  mkdirSync(iconset, { recursive: true })
  // The standard macOS iconset matrix (size + @2x retina variants).
  const variants: Array<{ size: number; name: string }> = [
    { size: 16, name: "icon_16x16.png" },
    { size: 32, name: "icon_16x16@2x.png" },
    { size: 32, name: "icon_32x32.png" },
    { size: 64, name: "icon_32x32@2x.png" },
    { size: 128, name: "icon_128x128.png" },
    { size: 256, name: "icon_128x128@2x.png" },
    { size: 256, name: "icon_256x256.png" },
    { size: 512, name: "icon_256x256@2x.png" },
    { size: 512, name: "icon_512x512.png" },
    { size: 1024, name: "icon_512x512@2x.png" },
  ]
  for (const { size, name } of variants) {
    sips(["-z", String(size), String(size), masterPng, "--out", join(iconset, name)])
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(BUILD_DIR, "icon.icns")], {
    stdio: "ignore",
  })
  rmSync(iconset, { recursive: true, force: true })
}

function main(): void {
  if (!existsSync(SOURCE)) {
    throw new Error(`source icon not found at ${SOURCE}`)
  }
  mkdirSync(BUILD_DIR, { recursive: true })

  const masterPng = join(BUILD_DIR, "icon.png")
  cpSync(SOURCE, masterPng)
  console.log(`icon.png  → ${masterPng}`)

  if (process.platform === "darwin") {
    buildIcns(masterPng)
    console.log(`icon.icns → ${join(BUILD_DIR, "icon.icns")}`)
  } else {
    console.log("non-macOS host: skipping icon.icns (electron-builder derives from icon.png)")
  }
}

main()
