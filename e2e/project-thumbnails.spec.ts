import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test"

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "desktop")
const MAIN_ENTRY = join(DESKTOP_DIR, "out", "main", "index.js")
const desktopRequire = createRequire(join(DESKTOP_DIR, "package.json"))
const ELECTRON_PATH = desktopRequire("electron") as string
// biome-ignore lint/suspicious/noUndeclaredEnvVars: This Playwright launcher runs outside Turbo.
const PACKAGED_BINARY = process.env.PI_LAB_PACKAGED_BINARY
const Database = desktopRequire("better-sqlite3") as typeof import("better-sqlite3")
const execFileAsync = promisify(execFile)
const ANIMATED_GIF = Buffer.from(
  "R0lGODlhAgABAPAAAP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAFAAAACwAAAAAAgABAAACAgQKACH5BAAUAAAALAAAAAACAAEAgAAA/wAAAAICBAoAOw==",
  "base64",
)
const LEGACY_WEBP = [
  {
    name: "lossy",
    base64:
      "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAEAAgA0JaACdLoB+AADsAD+8MQL/yC5YXXI1/8gP+QH/ID/+PIAAAA=",
    pixel: [255, 0, 2, 255],
  },
  {
    name: "lossless",
    base64: "UklGRhwAAABXRUJQVlA4TA8AAAAvAQAAAAcQ/Y/+ByKi/wEA",
    pixel: [255, 0, 0, 255],
  },
  {
    name: "animated",
    base64:
      "UklGRsAAAABXRUJQVlA4WAoAAAACAAAAAQAAAAAAQU5JTQYAAAD/////AABBTk1GSAAAAAAAAAAAAAEAAAAAAMgAAAJWUDggMAAAANABAJ0BKgIAAQACADQloAJ0ugH4AAOwAP7wxAv/ILlhdcjX/yA/5Af8gP/48gAAAEFOTUZEAAAAAAAAAAAAAQAAAAAAyAAAAFZQOCAsAAAAlAEAnQEqAgABAAAANCWgAnS6AAOYAP75k2//kB//kB//kB//ID/iF3sgMAA=",
    pixel: [255, 0, 2, 255],
  },
] as const
const TRANSLUCENT_WEBP = "UklGRh4AAABXRUJQVlA4TBEAAAAvAQAAEAdQmZI1o4CBiOh/AAA="
const OFFSET_ANIMATED_WEBP =
  "UklGRoYAAABXRUJQVlA4WAoAAAASAAAABAAAAQAAQU5JTQYAAAD/////AABBTk1GKgAAAAEAAAAAAAIAAAEAAMgAAAJWUDhMEQAAAC8CQAAQDxDzHwMYjBpE9D8AAEFOTUYoAAAAAAAAAAAAAwAAAQAAyAAAAFZQOEwPAAAALwNAAAAHENH//gciov8BAA=="
const LEGACY_JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z"

let app: ElectronApplication
let dataDir: string

test.beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-lab-e2e-thumbnails-"))
  const repoDir = join(dataDir, "repo")
  await execFileAsync("git", ["init", "-b", "main", repoDir])
  await execFileAsync("git", ["-C", repoDir, "config", "user.email", "test@pi-lab.local"])
  await execFileAsync("git", ["-C", repoDir, "config", "user.name", "PI Lab Test"])
  await writeFile(join(repoDir, "note.md"), "# Thumbnail fixture\n")
  await execFileAsync("git", ["-C", repoDir, "add", "."])
  await execFileAsync("git", ["-C", repoDir, "commit", "-m", "initial"])
  app = await electron.launch({
    executablePath: PACKAGED_BINARY ?? ELECTRON_PATH,
    args: PACKAGED_BINARY ? [] : [MAIN_ENTRY],
    env: {
      ...process.env,
      PI_LAB_TEST_MODE: "1",
      PI_LAB_DATA_DIR: dataDir,
      PI_LAB_SOCKET_PATH: join(dataDir, "daemon.sock"),
      PI_LAB_TEST_OPEN_PROJECT: repoDir,
    },
  })
})

test.afterEach(async () => {
  await app?.close()
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

test("an animated GIF stays animated on the card while the sidebar gets a static badge", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const picker = window.getByTestId("project-card-thumbnail-input")
  await picker.setInputFiles({ name: "animated.gif", mimeType: "image/gif", buffer: ANIMATED_GIF })
  const cardImage = window.getByTestId("project-card-image").locator("img")
  await expect(cardImage).toHaveAttribute(
    "src",
    `data:image/gif;base64,${ANIMATED_GIF.toString("base64")}`,
  )
  const badgeImage = window.getByTestId("project-sessions-toggle").locator("img")
  await expect(badgeImage).toHaveAttribute("src", /^data:image\/png;base64,/)
  await expect
    .poll(async () => badgeImage.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0)
  const firstPixel = await badgeImage.evaluate((image: HTMLImageElement) => {
    const canvas = document.createElement("canvas")
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Canvas unavailable")
    context.drawImage(image, 0, 0)
    return [...context.getImageData(0, 0, 1, 1).data]
  })
  expect(firstPixel[0]).toBeGreaterThan(200)
  expect(firstPixel[2]).toBeLessThan(50)
  expect(
    await badgeImage.evaluate((image: HTMLImageElement) =>
      Math.max(image.naturalWidth, image.naturalHeight),
    ),
  ).toBeLessThanOrEqual(64)
  const previous = await cardImage.getAttribute("src")
  await picker.setInputFiles({
    name: "oversized.gif",
    mimeType: "image/gif",
    buffer: Buffer.concat([ANIMATED_GIF, Buffer.alloc(1_000_000)]),
  })
  await expect(window.getByRole("alert")).toContainText("1 MB")
  await expect(cardImage).toHaveAttribute("src", previous as string)
})

test("still images preserve aspect ratio, do not upscale, and fit the encoded cap", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const picker = window.getByTestId("project-card-thumbnail-input")
  const source = await window.evaluate(() => {
    const canvas = document.createElement("canvas")
    canvas.width = 1200
    canvas.height = 600
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Canvas unavailable")
    context.fillStyle = "#e74028"
    context.fillRect(0, 0, 1200, 600)
    return canvas.toDataURL("image/png").split(",")[1] as string
  })
  await picker.setInputFiles({
    name: "wide.png",
    mimeType: "image/png",
    buffer: Buffer.from(source, "base64"),
  })
  const cardImage = window.getByTestId("project-card-image").locator("img")
  await expect(cardImage).toBeVisible()
  await expect
    .poll(async () =>
      cardImage.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight]),
    )
    .toEqual([640, 320])
  const encoded = await cardImage.getAttribute("src")
  expect(
    Buffer.from((encoded as string).split(",")[1] as string, "base64").length,
  ).toBeLessThanOrEqual(1_000_000)
  const smallSource = await window.evaluate(() => {
    const canvas = document.createElement("canvas")
    canvas.width = 20
    canvas.height = 10
    return canvas.toDataURL("image/png").split(",")[1] as string
  })
  await picker.setInputFiles({
    name: "small.png",
    mimeType: "image/png",
    buffer: Buffer.from(smallSource, "base64"),
  })
  await expect
    .poll(async () =>
      cardImage.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight]),
    )
    .toEqual([20, 10])
})

/** Seed an unchanged older row, then let the real app read both thumbnail variants. */
async function seedLegacyThumbnail(dataUrl: string): Promise<void> {
  const window = await app.firstWindow()
  await expect(window.getByTestId("project-card")).toBeVisible()
  const sqlite = new Database(join(dataDir, "local.db"))
  try {
    const result = sqlite
      .prepare("UPDATE projects SET thumbnail = ?, gradient = NULL, digital_rain = 0")
      .run(dataUrl)
    expect(result.changes).toBe(1)
  } finally {
    sqlite.close()
  }
  await window.reload()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId("project-card")).toBeVisible()
}

/** Read a badge pixel after the browser has decoded the returned static PNG. */
async function badgePixel(x: number): Promise<number[]> {
  const window = await app.firstWindow()
  const image = window.getByTestId("project-sessions-toggle").locator("img")
  await expect(image).toHaveAttribute("src", /^data:image\/png;base64,/)
  await expect
    .poll(async () => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0)
  return image.evaluate((element: HTMLImageElement, pixelX) => {
    const canvas = document.createElement("canvas")
    canvas.width = element.naturalWidth
    canvas.height = element.naturalHeight
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Canvas unavailable")
    context.drawImage(element, 0, 0)
    return [...context.getImageData(pixelX, 0, 1, 1).data]
  }, x)
}

test("older WebP cards keep original bytes and badges decode static first frames", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  for (const fixture of LEGACY_WEBP) {
    const dataUrl = `data:image/webp;base64,${fixture.base64}`
    await seedLegacyThumbnail(dataUrl)
    await expect(window.getByTestId("project-card-image").locator("img")).toHaveAttribute(
      "src",
      dataUrl,
    )
    const pixel = await badgePixel(0)
    expect(pixel[0], fixture.name).toBeGreaterThan(200)
    expect(pixel[1], fixture.name).toBeLessThan(40)
    expect(pixel[2], fixture.name).toBeLessThan(40)
    expect(pixel[3], fixture.name).toBe(255)
  }
})

test("an older JPEG card remains visible and gets a static PNG badge", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  const dataUrl = `data:image/jpeg;base64,${LEGACY_JPEG}`
  await seedLegacyThumbnail(dataUrl)
  await expect(window.getByTestId("project-card-image").locator("img")).toHaveAttribute(
    "src",
    dataUrl,
  )
  const pixel = await badgePixel(0)
  expect(pixel[0]).toBeGreaterThan(200)
  expect(pixel[1]).toBeLessThan(40)
  expect(pixel[2]).toBeLessThan(40)
})

test("older translucent and offset animated WebP badges preserve alpha and first-frame placement", async () => {
  const window = await app.firstWindow()
  await expect(window.getByTestId("app-ready")).toBeVisible({ timeout: 30_000 })
  await seedLegacyThumbnail(`data:image/webp;base64,${TRANSLUCENT_WEBP}`)
  const translucent = await badgePixel(0)
  expect(translucent[0]).toBeGreaterThanOrEqual(95)
  expect(translucent[0]).toBeLessThanOrEqual(105)
  expect(translucent[1]).toBeGreaterThanOrEqual(45)
  expect(translucent[1]).toBeLessThanOrEqual(55)
  expect(translucent[2]).toBeGreaterThanOrEqual(20)
  expect(translucent[2]).toBeLessThanOrEqual(30)
  expect(translucent[3]).toBe(128)

  await seedLegacyThumbnail(`data:image/webp;base64,${OFFSET_ANIMATED_WEBP}`)
  expect(await badgePixel(0)).toEqual([255, 255, 255, 255])
  expect(await badgePixel(2)).toEqual([0, 0, 0, 0])
  const movedPixel = await badgePixel(3)
  expect(movedPixel[0]).toBeGreaterThan(230)
  expect(movedPixel[1]).toBe(0)
  expect(movedPixel[2]).toBe(0)
  expect(movedPixel[3]).toBe(128)

  const blended = Buffer.from(OFFSET_ANIMATED_WEBP, "base64")
  const frame = blended.indexOf(Buffer.from("ANMF"))
  expect(frame).toBeGreaterThan(0)
  blended[frame + 8 + 15] = 0
  await seedLegacyThumbnail(`data:image/webp;base64,${blended.toString("base64")}`)
  expect(await badgePixel(2)).toEqual([255, 255, 255, 255])
  const blendedPixel = await badgePixel(3)
  expect(blendedPixel[0]).toBeGreaterThan(230)
  expect(blendedPixel[1]).toBeGreaterThan(100)
  expect(blendedPixel[1]).toBeLessThan(160)
  expect(blendedPixel[2]).toBeGreaterThan(100)
  expect(blendedPixel[2]).toBeLessThan(160)
  expect(blendedPixel[3]).toBe(255)
})
