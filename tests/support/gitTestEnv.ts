import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "vitest"

/**
 * Vitest setup for main-process tests: every git call (the tests' own fixtures and
 * the code under test) reads a test global config with only a test identity, and
 * no system config. The developer's own git config stays out of the tests, e.g. a
 * global `core.hooksPath` whose hooks run on every commit, checkout and ref update
 * made a conflicted-repo fixture take 4 s instead of 0.3 s and time tests out.
 * Tests that need their own global config still set GIT_CONFIG_GLOBAL themselves.
 */
const dir = mkdtempSync(join(tmpdir(), "pi-lab-test-gitconfig-"))
const config = join(dir, "gitconfig")
writeFileSync(config, "[user]\n\tname = PI Lab Test\n\temail = test@pi-lab.local\n")
process.env.GIT_CONFIG_GLOBAL = config
process.env.GIT_CONFIG_NOSYSTEM = "1"

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
