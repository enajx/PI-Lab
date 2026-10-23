import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { planResearchPrompt } from "./planResearchSkill"

test("bundled Plan research takes priority over a user copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lab-bundled-skill-"))
  try {
    const bundled = join(root, "bundled")
    const home = join(root, "home")
    for (const [directory, content] of [
      [join(bundled, "plan-research"), "BUNDLED INSTRUCTIONS"],
      [join(home, ".agents/skills/plan-research"), "USER INSTRUCTIONS"],
    ] as const) {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, "SKILL.md"), content)
    }
    const prompt = await planResearchPrompt(join(root, "project"), home, bundled)
    expect(prompt).toContain("BUNDLED INSTRUCTIONS")
    expect(prompt).not.toContain("USER INSTRUCTIONS")
    expect(prompt).toContain(join(bundled, "plan-research", "SKILL.md"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
