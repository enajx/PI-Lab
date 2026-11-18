/**
 * Order of PI Lab release versions (`1.2.3`, `1.2.3-beta`, `1.2.3-beta.2`),
 * as semver orders them: a prerelease comes before its release. Throws on
 * a version that is not of that form.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let index = 0; index < 3; index++) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    return Math.sign(right.pre.length - left.pre.length)
  }
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const x = left.pre[index]
    const y = right.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNumber = /^\d+$/.test(x)
    const yNumber = /^\d+$/.test(y)
    if (xNumber && yNumber) return Math.sign(Number(x) - Number(y))
    if (xNumber) return -1
    if (yNumber) return 1
    return x < y ? -1 : 1
  }
  return 0
}

function parseVersion(version: string): { core: number[]; pre: string[] } {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
  if (!match) throw new Error(`Not a PI Lab version: ${version}`)
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  }
}
