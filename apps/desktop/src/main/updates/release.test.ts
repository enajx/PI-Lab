import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { publicReleaseFromPackage, updaterFeedChannel } from "./release"

const directories: string[] = []

/** Write the metadata that electron-builder places inside a packaged app. */
function appPath(metadata: Record<string, unknown>): string {
  const path = mkdtempSync(join(tmpdir(), "pi-lab-updates-release-"))
  directories.push(path)
  writeFileSync(join(path, "package.json"), JSON.stringify(metadata))
  return path
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe("public update release identity", () => {
  test("local development packages and source runs never use the public updater", () => {
    expect(publicReleaseFromPackage(false, appPath({ piLabPublicRelease: true }))).toBeNull()
    expect(publicReleaseFromPackage(true, appPath({ piLabChannel: "alpha" }))).toBeNull()
  })

  test("public channels keep the stable app identity while using their own feed", () => {
    for (const channel of ["stable", "beta"] as const) {
      const release = publicReleaseFromPackage(
        true,
        appPath({ piLabChannel: "stable", piLabPublicRelease: true, piLabReleaseChannel: channel }),
      )
      expect(release).toEqual({ channel })
    }
    expect(updaterFeedChannel("stable")).toBe("latest")
    expect(updaterFeedChannel("beta")).toBe("beta")
  })

  test("an invalid public release fails visibly instead of silently checking the wrong feed", () => {
    expect(() =>
      publicReleaseFromPackage(
        true,
        appPath({ piLabChannel: "alpha", piLabPublicRelease: true, piLabReleaseChannel: "beta" }),
      ),
    ).toThrow(/stable app identity/i)
    expect(() =>
      publicReleaseFromPackage(
        true,
        appPath({
          piLabChannel: "stable",
          piLabPublicRelease: true,
          piLabReleaseChannel: "canary",
        }),
      ),
    ).toThrow(/release channel/i)
    expect(() =>
      publicReleaseFromPackage(
        true,
        appPath({
          piLabChannel: "stable",
          piLabPublicRelease: true,
          piLabReleaseChannel: "nightly",
        }),
      ),
    ).toThrow(/release channel/i)
  })
})
