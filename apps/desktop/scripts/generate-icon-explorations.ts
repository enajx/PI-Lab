#!/usr/bin/env bun
/**
 * Generate unshipped uppercase-Pi font explorations.
 *
 * Every output keeps the canonical application's 1024px canvas and white
 * macOS-style tile (x/y 64, 896px square, 210px corner radius). Only the
 * centered black `Π` glyph changes. These explorations intentionally do not
 * touch `icons/icon.svg`, `icons/icon.png`, or packaged build resources.
 *
 * Requires ImageMagick, librsvg (`rsvg-convert`), fontconfig (`fc-query`), and
 * the listed macOS fonts.
 */

import { execFileSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

interface IconExploration {
  fileName: string
  label: string
  family: string
  weight: number
  fontPath: string
}

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, "..", "..", "..")
const OUTPUT_DIR = join(REPO_ROOT, "icons-temp")
const SUPPLEMENTAL_FONTS = "/System/Library/Fonts/Supplemental"

export const ICON_EXPLORATIONS: readonly IconExploration[] = [
  {
    fileName: "01-baskerville-regular.png",
    label: "Baskerville — Regular",
    family: "Baskerville",
    weight: 400,
    fontPath: join(SUPPLEMENTAL_FONTS, "Baskerville.ttc"),
  },
  {
    fileName: "02-didot-bold.png",
    label: "Didot — Bold",
    family: "Didot",
    weight: 700,
    fontPath: join(SUPPLEMENTAL_FONTS, "Didot.ttc"),
  },
  {
    fileName: "03-times-new-roman-regular.png",
    label: "Times New Roman — Regular",
    family: "Times New Roman",
    weight: 400,
    fontPath: join(SUPPLEMENTAL_FONTS, "Times New Roman.ttf"),
  },
  {
    fileName: "04-georgia-regular.png",
    label: "Georgia — Regular",
    family: "Georgia",
    weight: 400,
    fontPath: join(SUPPLEMENTAL_FONTS, "Georgia.ttf"),
  },
  {
    fileName: "05-palatino-regular.png",
    label: "Palatino — Regular",
    family: "Palatino",
    weight: 400,
    fontPath: "/System/Library/Fonts/Palatino.ttc",
  },
  {
    fileName: "06-stix-two-text-regular.png",
    label: "STIX Two Text — Regular",
    family: "STIX Two Text",
    weight: 400,
    fontPath: join(SUPPLEMENTAL_FONTS, "STIXTwoText.ttf"),
  },
  {
    fileName: "07-avenir-next-medium.png",
    label: "Avenir Next — Medium",
    family: "Avenir Next",
    weight: 500,
    fontPath: "/System/Library/Fonts/Avenir Next.ttc",
  },
  {
    fileName: "08-futura-medium.png",
    label: "Futura — Medium",
    family: "Futura",
    weight: 500,
    fontPath: join(SUPPLEMENTAL_FONTS, "Futura.ttc"),
  },
  {
    fileName: "09-helvetica-neue-medium.png",
    label: "Helvetica Neue — Medium",
    family: "Helvetica Neue",
    weight: 500,
    fontPath: "/System/Library/Fonts/HelveticaNeue.ttc",
  },
  {
    fileName: "10-gill-sans-regular.png",
    label: "Gill Sans — Regular",
    family: "Gill Sans",
    weight: 400,
    fontPath: join(SUPPLEMENTAL_FONTS, "GillSans.ttc"),
  },
  {
    fileName: "11-rockwell-regular.png",
    label: "Rockwell — Regular",
    family: "Rockwell",
    weight: 400,
    fontPath: join(SUPPLEMENTAL_FONTS, "Rockwell.ttc"),
  },
  {
    fileName: "12-copperplate-regular.png",
    label: "Copperplate — Regular",
    family: "Copperplate",
    weight: 400,
    fontPath: join(SUPPLEMENTAL_FONTS, "Copperplate.ttc"),
  },
]

function readme(): string {
  const rows = ICON_EXPLORATIONS.map(
    ({ fileName, label, fontPath }) =>
      `| ![${label}](./${fileName}) | \`${fileName}\` | ${label} | \`${fontPath}\` |`,
  ).join("\n")
  return `# Pi tile font explorations

These 12 unshipped explorations use the current 1024×1024 white rounded tile with
transparent outer corners. Only the centered black uppercase Greek Pi changes.

Regenerate on macOS with ImageMagick, \`rsvg-convert\`, and fontconfig
(\`fc-query\`). Each render gets an isolated fontconfig directory containing
only the declared font file, so system fallback cannot change the glyph.

\`\`\`sh
bun apps/desktop/scripts/generate-icon-explorations.ts
\`\`\`

| Preview | File | Font style | Local font source |
| --- | --- | --- | --- |
${rows}
`
}

function fontSupportsGreekPi(fontPath: string): boolean {
  const charset = execFileSync("fc-query", ["--format=%{charset}", fontPath], {
    encoding: "utf8",
  })
  for (const token of charset.match(/[0-9a-f]+(?:-[0-9a-f]+)?/g) ?? []) {
    const [first, last = first] = token.split("-")
    const start = Number.parseInt(first ?? "", 16)
    const end = Number.parseInt(last ?? "", 16)
    if (start <= 0x3a0 && 0x3a0 <= end) return true
  }
  return false
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

export function generateIconExplorations(): void {
  for (const { fontPath } of ICON_EXPLORATIONS) {
    if (!existsSync(fontPath)) {
      throw new Error(`required exploration font is unavailable: ${fontPath}`)
    }
    if (!fontSupportsGreekPi(fontPath)) {
      throw new Error(`exploration font has no uppercase Greek Pi glyph: ${fontPath}`)
    }
  }

  mkdirSync(OUTPUT_DIR, { recursive: true })
  for (const entry of readdirSync(OUTPUT_DIR)) {
    if (entry.toLowerCase().endsWith(".png")) {
      rmSync(join(OUTPUT_DIR, entry))
    }
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-lab-icon-explorations-"))
  for (const { fileName, family, weight, fontPath } of ICON_EXPLORATIONS) {
    const output = join(OUTPUT_DIR, fileName)
    const glyphSvg = join(temporaryDirectory, `${fileName}.svg`)
    const glyphPng = join(temporaryDirectory, `${fileName}.png`)
    const isolatedFontDirectory = join(temporaryDirectory, `${fileName}-font`)
    const fontCacheDirectory = join(temporaryDirectory, `${fileName}-cache`)
    const fontConfigPath = join(temporaryDirectory, `${fileName}-fonts.conf`)
    mkdirSync(isolatedFontDirectory)
    mkdirSync(fontCacheDirectory)
    copyFileSync(fontPath, join(isolatedFontDirectory, basename(fontPath)))
    writeFileSync(
      fontConfigPath,
      `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>${escapeXml(isolatedFontDirectory)}</dir>
  <cachedir>${escapeXml(fontCacheDirectory)}</cachedir>
  <config />
</fontconfig>
`,
    )
    writeFileSync(
      glyphSvg,
      `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
  <text x="512" y="512" text-anchor="middle" dominant-baseline="central"
    font-family="${family}" font-weight="${weight}" font-size="650" fill="#000">Π</text>
</svg>
`,
    )
    execFileSync("rsvg-convert", [glyphSvg, "-o", glyphPng], {
      stdio: "inherit",
      env: {
        ...process.env,
        FONTCONFIG_FILE: fontConfigPath,
        FONTCONFIG_PATH: temporaryDirectory,
      },
    })
    execFileSync(
      "magick",
      [
        "-size",
        "1024x1024",
        "canvas:none",
        "-fill",
        "#ffffff",
        "-stroke",
        "none",
        "-draw",
        "roundrectangle 64,64 960,960 210,210",
        "(",
        glyphPng,
        "-trim",
        "+repage",
        "-resize",
        "520x520",
        ")",
        "-gravity",
        "center",
        "-composite",
        "-depth",
        "8",
        "-strip",
        `PNG32:${output}`,
      ],
      { stdio: "inherit" },
    )
    console.log(`${basename(output)} — ${fontPath}`)
  }
  rmSync(temporaryDirectory, { recursive: true, force: true })

  writeFileSync(join(OUTPUT_DIR, "README.md"), readme())
}

generateIconExplorations()
