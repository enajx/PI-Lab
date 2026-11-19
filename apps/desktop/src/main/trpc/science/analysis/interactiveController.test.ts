import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { AnalysisInteractiveController } from "./interactiveController"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** Open a report in a temp project and return the controller and its report URL. */
async function openFixture() {
  const repo = await mkdtemp(join(tmpdir(), "report-"))
  directories.push(repo)
  await mkdir(join(repo, "out"))
  await writeFile(join(repo, "out", "report.html"), "<html>hi</html>")
  await writeFile(join(repo, "out", "data.json"), "0123456789")
  await writeFile(join(repo, "secret.txt"), "secret")
  await symlink(join(repo, "secret.txt"), join(repo, "out", "link.txt"))
  const controller = new AnalysisInteractiveController()
  const generation = await controller.begin("owner", "lease")
  const result = await controller.openReport({
    ownerId: "owner",
    generation,
    absPath: join(repo, "out", "report.html"),
    repoPath: repo,
  })
  const base = (result as { url: string }).url.replace(/report\.html$/, "")
  return { controller, base }
}

describe("AnalysisInteractiveController.handleReportRequest (no Electron)", () => {
  test("serves a granted file with its content type and honours Range", async () => {
    const { controller, base } = await openFixture()
    const full = await controller.handleReportRequest(new Request(`${base}report.html`))
    expect(full.status).toBe(200)
    expect(full.headers.get("content-type")).toContain("text/html")
    expect(await full.text()).toBe("<html>hi</html>")
    const part = await controller.handleReportRequest(
      new Request(`${base}data.json`, { headers: { range: "bytes=2-4" } }),
    )
    expect(part.status).toBe(206)
    expect(part.headers.get("content-range")).toBe("bytes 2-4/10")
    expect(await part.text()).toBe("234")
    const bad = await controller.handleReportRequest(
      new Request(`${base}data.json`, { headers: { range: "bytes=50-60" } }),
    )
    expect(bad.status).toBe(416)
  })

  test("rejects traversal, symlink escapes, unknown tokens and closed previews", async () => {
    const { controller, base } = await openFixture()
    const get = (path: string) => controller.handleReportRequest(new Request(path))
    expect((await get(`${base}..%2Fsecret.txt`)).status).toBe(404)
    expect((await get(`${base}link.txt`)).status).toBe(404)
    expect((await get(`${base}missing.js`)).status).toBe(404)
    expect((await get(base.replace(/\/\/[^/]+/, "//unknown"))).status).toBe(404)
    await controller.close("owner", "lease")
    expect((await get(`${base}report.html`)).status).toBe(404)
  })
})
