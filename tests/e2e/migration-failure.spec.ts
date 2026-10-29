import { execFile } from "node:child_process"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import {
  TEST_DIALOG_LOG_PREFIX,
  type TestDialogRecord,
} from "../../apps/desktop/src/main/runtime/testDialogs"
import { expect, test } from "./fixtures/playwright"

const desktopRequire = createRequire(resolve("apps/desktop/package.json"))
const Database = desktopRequire("better-sqlite3")
const electronPath: string = desktopRequire("electron")
const mainEntry = resolve("apps/desktop/out/main/index.js")

const execFileAsync = promisify(execFile)

// Real Electron startup and SQLite. Test mode's dialog responder answers the
// native error box in place of showing it and prints it to stdout, so this
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
      const result = await execFileAsync(
        electronPath,
        process.platform === "linux" ? ["--no-sandbox", mainEntry] : [mainEntry],
        {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "",
            PI_LAB_TEST_MODE: "1",
            PI_LAB_DATA_DIR: dir,
            PI_LAB_SOCKET_PATH: join(dir, "daemon.sock"),
          },
          timeout: 20_000,
          killSignal: "SIGKILL",
        },
      ).then(
        ({ stdout }) => ({ code: 0, stdout }),
        (error: { code: number | string; stdout: string }) => error,
      )
      expect(result.code).toBe(1)
      const dialogs: TestDialogRecord[] = result.stdout
        .split("\n")
        .filter((line) => line.includes(TEST_DIALOG_LOG_PREFIX))
        .map((line) =>
          JSON.parse(
            line.slice(line.indexOf(TEST_DIALOG_LOG_PREFIX) + TEST_DIALOG_LOG_PREFIX.length),
          ),
        )
      const dialog = dialogs.find(({ kind }) => kind === "errorBox")
      if (!dialog) throw new Error(`Expected a startup error box, got ${result.stdout}`)
      expect(dialog.title).toContain("database")
      expect(dialog.message).toContain("backup")
      expect(dialog.message).toContain(join(dir, "local.db"))
      const backups = (await readdir(dir)).filter((name) => name.startsWith("local.db.backup-"))
      if (fixture === "unreadable file") {
        expect(dialog.message).toContain("backup could not be created")
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
