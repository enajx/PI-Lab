import { resolve } from "node:path"
import type { nativeImage } from "electron"
import { describe, expect, test } from "vitest"
import { decodeRgbaPng } from "../../../scripts/generate-app-icon"
import type { AppIconSelection } from "../../shared/appIcon"
import { APP_ICON_DEFAULT_SELECTION } from "../../shared/appIcon"
import {
  createAlphaDockIcon,
  createBetaDockIcon,
  recolorBetaDockBitmap,
  recolorWhiteTileBitmap,
} from "./betaDockIcon"

describe("public Beta Dock icon", () => {
  test("uses the selected solid #303030 tile at runtime", () => {
    const imageFactory = {
      createFromPath: () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 1, height: 1 }),
        toBitmap: () => Buffer.from([4, 0, 0, 255]),
      }),
      createFromBitmap: (bitmap: Buffer) => ({ toBitmap: () => bitmap }),
    } as unknown as typeof nativeImage
    const icon = createBetaDockIcon(
      "magma-tile.png",
      { ...APP_ICON_DEFAULT_SELECTION },
      "unused-for-solid-colors.json",
      imageFactory,
    )
    expect([...icon.toBitmap()]).toEqual([48, 48, 48, 255])
  })
  test("uses the Stable palette on the tile and keeps the symbol white", () => {
    // macOS NativeImage bitmaps use premultiplied BGRA pixels.
    const source = Buffer.from([0, 50, 100, 255, 255, 255, 255, 255, 0, 25, 50, 128, 0, 0, 0, 0])
    const recolored = recolorBetaDockBitmap(source, 2, 2, {
      sourceGradient: Uint8Array.from([100, 50, 0, 100, 50, 0]),
      targetGradient: Uint8Array.from([0, 100, 200, 0, 100, 200]),
    })
    expect([...recolored.subarray(0, 4)]).toEqual([200, 100, 0, 255])
    expect([...recolored.subarray(4, 8)]).toEqual([255, 255, 255, 255])
    expect(recolored[11]).toBe(128)
    expect([...recolored.subarray(12, 16)]).toEqual([0, 0, 0, 0])
  })
})

describe("Alpha white-background icon", () => {
  test("maps the symbol gradient and preserves the white tile and transparency", () => {
    const source = Buffer.from([255, 255, 255, 255, 20, 100, 40, 255, 0, 0, 0, 0])
    const recolored = recolorWhiteTileBitmap(source, 3, 1, ["#286414"], ["#c86400"])
    expect([...recolored.subarray(0, 4)]).toEqual([255, 255, 255, 255])
    expect([...recolored.subarray(4, 8)]).toEqual([0, 100, 200, 255])
    expect([...recolored.subarray(8, 12)]).toEqual([0, 0, 0, 0])
  })

  test("renders a chosen palette on the real colored and white icon masters", () => {
    const gallery = resolve(
      process.cwd(),
      "apps/desktop/src/renderer/routes/_shell/settings/components/AppIconGallery",
    )
    const palettePath = resolve(
      process.cwd(),
      "apps/desktop/assets/icons/matplotlib-colormaps-3.11.2.json",
    )
    const master = (path: string) => {
      const { width, height, pixels } = decodeRgbaPng(path)
      const bitmap = Buffer.alloc(pixels.length)
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const alpha = pixels[offset + 3] ?? 0
        bitmap[offset] = Math.round(((pixels[offset + 2] ?? 0) * alpha) / 255)
        bitmap[offset + 1] = Math.round(((pixels[offset + 1] ?? 0) * alpha) / 255)
        bitmap[offset + 2] = Math.round(((pixels[offset] ?? 0) * alpha) / 255)
        bitmap[offset + 3] = alpha
      }
      return { width, height, bitmap }
    }
    const imageFactory = {
      createFromPath: (path: string) => {
        const image = master(path)
        return {
          isEmpty: () => false,
          getSize: () => ({ width: image.width, height: image.height }),
          toBitmap: () => image.bitmap,
        }
      },
      createFromBitmap: (bitmap: Buffer) => ({ toBitmap: () => bitmap }),
    } as unknown as typeof nativeImage
    const selection = {
      ...APP_ICON_DEFAULT_SELECTION,
      family: "joyplot" as const,
      joyplotPalette: "plasma" as const,
    }
    const coloredSource = resolve(gallery, "channel-icons/joyplot-25-alpha-expanded.png")
    const whiteSource = resolve(gallery, "icons/joyplot-25-viridis-expanded.png")
    const pixel = (bitmap: Buffer, x: number, y: number) => {
      const offset = (y * 256 + x) * 4
      return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]]
    }

    const colored = createAlphaDockIcon(
      coloredSource,
      selection,
      palettePath,
      imageFactory,
    ).toBitmap()
    const white = createAlphaDockIcon(
      whiteSource,
      { ...selection, alphaWhiteBackground: true },
      palettePath,
      imageFactory,
    ).toBitmap()
    expect(pixel(colored, 128, 20)).not.toEqual(pixel(master(coloredSource).bitmap, 128, 20))
    expect(pixel(colored, 90, 60)).toEqual([255, 255, 255])
    expect(pixel(white, 128, 20)).toEqual([255, 255, 255])
    expect(pixel(white, 90, 60)).not.toEqual(pixel(master(whiteSource).bitmap, 90, 60))
    const cases: { source: string; choice: AppIconSelection }[] = [
      {
        source: "icons/joyplot-37-viridis-expanded.png",
        choice: {
          ...selection,
          joyplotStyle: "37",
          joyplotPalette: "cividis",
          joyplotReverse: true,
          alphaWhiteBackground: true,
        },
      },
      {
        source: "icons/pi-didot-bold-viridis.png",
        choice: {
          ...selection,
          family: "pi",
          piFont: "didot-bold",
          piPalette: "plasma",
          piLimitVisibleRange: true,
          alphaWhiteBackground: true,
        },
      },
    ]
    for (const { source: sourceName, choice } of cases) {
      const sourcePath = resolve(gallery, sourceName)
      const rendered = createAlphaDockIcon(sourcePath, choice, palettePath, imageFactory)
      expect(rendered.toBitmap()).not.toEqual(master(sourcePath).bitmap)
      expect(pixel(rendered.toBitmap(), 128, 20)).toEqual([255, 255, 255])
    }
    const magmaSource = resolve(gallery, "icons/joyplot-25-viridis-expanded.png")
    const magma = createAlphaDockIcon(
      magmaSource,
      { ...selection, joyplotPalette: "magma", alphaWhiteBackground: true },
      palettePath,
      imageFactory,
    )
    expect(magma.toBitmap()).not.toEqual(master(magmaSource).bitmap)
  })
})
