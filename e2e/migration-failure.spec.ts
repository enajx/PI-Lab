import { execFile } from "node:child_process"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { expect, test } from "@playwright/test"

const desktopRequire = createRequire(resolve("apps/desktop/package.json"))
const Database = desktopRequire("better-sqlite3")
const electronPath: string = desktopRequire("electron")

const execFileAsync = promisify(execFile)

// Real Electron startup and SQLite. Only the native modal is intercepted so this
// unattended regression can inspect its text and let the process finish.
for (const fixture of ["partial schema", "unreadable file"]) {
  test(`startup reports migration failure for ${fixture}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-lab-migration-e2e-"))
    try {
      if (fixture === "partial schema") {
        const db = new Database(join(dir, "local.db"))
        db.exec(
          "CREATE TABLE projects (id TEXT); CREATE TABLE workspaces (id TEXT); INSERT INTO projects VALUES ('preserved');",
        )
        db.close()
      } else {
        await writeFile(join(dir, "local.db"), "not a database".repeat(100))
      }
      const resultPath = join(dir, "dialog.json")
      const launcher = join(dir, "launch.cjs")
      await writeFile(
        launcher,
        `const { dialog } = require("electron");
      dialog.showErrorBox = (title, content) => require('node:fs').writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({title, content}));
      require(${JSON.stringify(resolve("apps/desktop/out/main/index.js"))});`,
      )
      await execFileAsync(electronPath, [launcher], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "",
          PI_LAB_TEST_MODE: "1",
          PI_LAB_DATA_DIR: dir,
          PI_LAB_SOCKET_PATH: join(dir, "daemon.sock"),
        },
        timeout: 20_000,
      })
      const dialog = JSON.parse(await readFile(resultPath, "utf8"))
      expect(dialog.title).toContain("database")
      expect(dialog.content).toContain("backup")
      expect(dialog.content).toContain(join(dir, "local.db"))
      const backups = (await readdir(dir)).filter((name) => name.startsWith("local.db.backup-"))
      if (fixture === "unreadable file") {
        expect(dialog.content).toContain("backup could not be created")
        expect(backups).toHaveLength(0)
        expect(await readFile(join(dir, "local.db"), "utf8")).toBe("not a database".repeat(100))
        return
      }
      expect(backups).toHaveLength(1)
      const backup = backups[0]
      if (!backup) throw new Error("Expected a database backup")
      const saved = new Database(join(dir, backup))
      expect(saved.prepare("SELECT * FROM projects").all()).toEqual([{ id: "preserved" }])
      saved.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}
