import type { ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import { _electron, test as base, type ElectronApplication } from "@playwright/test"
import {
  TEST_DIALOG_LOG_PREFIX,
  type TestDialogRecord,
} from "../../../apps/desktop/src/main/runtime/testDialogs"

export * from "@playwright/test"

/**
 * Shared Playwright entry for every e2e spec: `@playwright/test` plus a `test`
 * that reports the native dialogs the app answered by itself in test mode
 * (apps/desktop/src/main/runtime/testDialogs.ts, at the repo root). Each
 * `_electron.launch` is watched for the responder's stdout lines; after each
 * test they are attached as `native-dialogs.json`, added as `native dialog`
 * annotations and printed. Reporting never fails a test.
 */

/** Dialog records seen since the last test reported them. */
const unreported: TestDialogRecord[] = []
/**
 * Stdout readers of launched apps; `ended` resolves when that app's stdout ends.
 * The child process is kept because `app.process()` throws once the app is closed.
 */
const readers: { child: ChildProcess; ended: Promise<void> }[] = []

function watch(app: ElectronApplication): void {
  const child = app.process()
  const stdout = child.stdout
  if (!stdout) throw new Error("Electron stdout is not piped; native dialogs cannot be reported")
  const lines = createInterface({ input: stdout })
  lines.on("line", (line) => {
    const start = line.indexOf(TEST_DIALOG_LOG_PREFIX)
    if (start < 0) return
    unreported.push(JSON.parse(line.slice(start + TEST_DIALOG_LOG_PREFIX.length)))
  })
  readers.push({ child, ended: new Promise((resolve) => lines.once("close", () => resolve())) })
}

function describe(record: TestDialogRecord): string {
  const chosen =
    record.kind === "errorBox"
      ? "(error box)"
      : record.response === null
        ? "(answered by the page dialog handler)"
        : `"${record.buttons[record.response] ?? record.response}"`
  return `${record.answeredBy}: ${record.title || "(no title)"} | ${record.message} -> ${chosen}`
}

export const test = base.extend<
  { nativeDialogReport: undefined },
  { nativeDialogWatch: undefined }
>({
  // Worker-wide, so apps launched in beforeAll hooks are watched too.
  nativeDialogWatch: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures must destructure their dependencies.
    async ({}, use) => {
      const launch = _electron.launch
      _electron.launch = async (...args: Parameters<typeof launch>) => {
        const app = await launch.apply(_electron, args)
        watch(app)
        return app
      }
      await use(undefined)
      _electron.launch = launch
      // Dialogs raised after the last test of the worker (afterAll cleanup).
      for (const record of unreported.splice(0))
        console.log(`[native dialog, after the last test] ${describe(record)}`)
    },
    { scope: "worker", auto: true },
  ],
  nativeDialogReport: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixtures must destructure their dependencies.
    async ({}, use, testInfo) => {
      await use(undefined)
      // An app closed in this test can still have its last lines in flight.
      const exited = readers.filter(
        ({ child }) => child.exitCode !== null || child.signalCode !== null,
      )
      await Promise.all(exited.map(({ ended }) => ended))
      for (const reader of exited) readers.splice(readers.indexOf(reader), 1)
      const records = unreported.splice(0)
      if (records.length === 0) return
      for (const record of records) {
        testInfo.annotations.push({ type: "native dialog", description: describe(record) })
        console.log(`[native dialog] ${describe(record)}`)
      }
      await testInfo.attach("native-dialogs.json", {
        body: JSON.stringify(records, null, 2),
        contentType: "application/json",
      })
    },
    { auto: true },
  ],
})
