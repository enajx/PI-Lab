// Mocked runGit: checks the exact git command `hasChanges` runs. Its result on
// real repos is covered by the `projects.gitState` router test.
import { beforeEach, expect, test, vi } from "vitest"

const runGit = vi.fn()
vi.mock("./runGit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runGit")>()),
  runGit,
}))

const { hasChanges } = await import("./git")

beforeEach(() => runGit.mockReset())

test("hasChanges runs git status without optional locks, so it never takes .git/index.lock", async () => {
  runGit.mockResolvedValue({ stdout: "?? new.txt\n", stderr: "" })
  expect(await hasChanges("/repo")).toBe(true)
  expect(runGit).toHaveBeenCalledWith(
    "/repo",
    ["--no-optional-locks", "status", "--porcelain", "--untracked-files=normal"],
    { timeoutMs: 10_000 },
  )
  runGit.mockResolvedValue({ stdout: "", stderr: "" })
  expect(await hasChanges("/repo")).toBe(false)
})
