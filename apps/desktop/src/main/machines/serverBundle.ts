import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/** The server bundle this app carries, which "Add machine" installs on a Mac without PI Lab. */
export interface ServerBundleFiles {
  tarball: string
  sha256File: string
  installer: string
  version: string
}

/**
 * The server bundle for this Mac's processor in `dir`
 * (`pi-lab-server-<version>-darwin-<arch>.tar.gz` and its `.sha256`), the
 * newest when there are several; null when there is none.
 * Packaged app: `Resources/server-bundle/` (with install.sh). Source runs:
 * `apps/desktop/release/server/` from `package-server-bundle.cjs`.
 */
export function findServerBundle(dir: string, installer: string): ServerBundleFiles | null {
  if (!existsSync(dir) || !existsSync(installer)) return null
  const suffix = `-darwin-${process.arch}.tar.gz`
  const found = readdirSync(dir)
    .filter((name) => name.startsWith("pi-lab-server-") && name.endsWith(suffix))
    .filter((name) => existsSync(join(dir, `${name}.sha256`)))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  const tarball = found[0]
  if (tarball === undefined) return null
  const name = tarball.split("/").at(-1) ?? ""
  return {
    tarball,
    sha256File: `${tarball}.sha256`,
    installer,
    version: name.slice("pi-lab-server-".length, -suffix.length),
  }
}
