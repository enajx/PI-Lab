import { expect, it } from "vitest"
import { compareVersions } from "../shared/serverVersion"
import { pickServerUpdate } from "./selfUpdate"

it("orders versions as semver does", () => {
  const sorted = ["1.0.0", "0.2.0", "0.2.0-beta.2", "0.2.0-beta", "0.10.0", "0.2.0-beta.10"].sort(
    compareVersions,
  )
  expect(sorted).toEqual([
    "0.2.0-beta",
    "0.2.0-beta.2",
    "0.2.0-beta.10",
    "0.2.0",
    "0.10.0",
    "1.0.0",
  ])
})

function release(version: string, prerelease: boolean, withBundle: boolean) {
  const name = `pi-lab-server-${version}-darwin-arm64.tar.gz`
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease,
    assets: withBundle
      ? [
          { name, browser_download_url: `https://example.test/${name}` },
          { name: `${name}.sha256`, browser_download_url: `https://example.test/${name}.sha256` },
        ]
      : [],
  }
}

it("picks the newest release of the channel with a server bundle, skipping failed versions", () => {
  const releases = [
    release("0.4.0-beta", true, true),
    release("0.3.1", false, false),
    release("0.3.0", false, true),
    release("0.2.0", false, true),
  ]
  expect(pickServerUpdate(releases, "stable", "0.2.0", "arm64", [])?.version).toBe("0.3.0")
  expect(pickServerUpdate(releases, "beta", "0.2.0", "arm64", [])?.version).toBe("0.4.0-beta")
  expect(pickServerUpdate(releases, "beta", "0.2.0", "arm64", ["0.4.0-beta"])?.version).toBe(
    "0.3.0",
  )
  expect(pickServerUpdate(releases, "stable", "0.3.0", "arm64", [])).toBeNull()
  expect(pickServerUpdate(releases, "stable", "0.2.0", "x64", [])).toBeNull()
})
