import { existsSync, realpathSync } from "node:fs"
import { cp, mkdtemp, rename, rm } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const repoRoot = resolve(import.meta.dir, "..")
const examplesRoot = join(repoRoot, "tests", "test-projects")
const projectNames = [
  "python-research",
  "julia-research",
  "cpp-research",
  "software-typescript",
  "paper-latex",
] as const

/** Copy the bundled examples outside this Git checkout as independent local folders. */
export async function prepareExamples(destination: string): Promise<string[]> {
  const requested = resolve(destination)
  const parent = realpathSync(dirname(requested))
  const target = join(parent, basename(requested))
  const withinRepo = relative(repoRoot, target)
  if (
    withinRepo === "" ||
    (withinRepo !== ".." && !withinRepo.startsWith(`..${sep}`) && !isAbsolute(withinRepo))
  ) {
    throw new Error("Choose a destination outside the PI Lab repo")
  }
  if (existsSync(target)) throw new Error(`Destination already exists: ${target}`)

  const staging = await mkdtemp(join(parent, ".pi-lab-examples-"))
  try {
    for (const name of projectNames) {
      await cp(join(examplesRoot, name), join(staging, name), { recursive: true })
    }
    if (existsSync(target)) throw new Error(`Destination already exists: ${target}`)
    await rename(staging, target)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return projectNames.map((name) => join(target, name))
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter((argument) => argument !== "--")
  if (args.length !== 1) {
    throw new Error("Usage: bun run test-projects:prepare -- <destination-outside-PI-Lab>")
  }
  const paths = await prepareExamples(args[0] as string)
  process.stdout.write(
    `Prepared ${paths.length} projects. Add each folder through PI Lab:\n${paths.join("\n")}\n`,
  )
}
