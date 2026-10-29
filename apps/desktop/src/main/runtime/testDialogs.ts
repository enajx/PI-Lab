import type { Dialog, MessageBoxOptions, MessageBoxSyncOptions } from "electron"

/**
 * Test-mode answers for native message dialogs. Playwright cannot click a native
 * macOS dialog, so under `PI_LAB_TEST_MODE=1` main replaces `showMessageBox`,
 * `showMessageBoxSync` and `showErrorBox` at boot and no real message dialog is
 * ever shown. A test sets answers through `globalThis.piLabTestDialogs`; a spec
 * that assigns its own `dialog.showMessageBox` later still replaces this one.
 *
 * A dialog without a matching answer gets a default: the first button whose
 * label starts with "Quit" (quit and stop confirmations, so app cleanup never
 * waits), otherwise `cancelId`, otherwise the last button. Every dialog is
 * recorded and printed to stdout as {@link TEST_DIALOG_LOG_PREFIX} + JSON, which
 * the e2e fixture attaches to the test report.
 *
 * A renderer `alert`/`confirm` reaches main as a message box with an abort
 * `signal`. Playwright answers those through the page (`page.on("dialog")`, or its
 * automatic dismiss), and Electron then aborts the box, so the responder waits
 * for that abort instead of answering, and uses the default only after
 * {@link PAGE_DIALOG_FALLBACK_MS}.
 */

/** Prefix of the stdout line printed for each answered dialog. */
export const TEST_DIALOG_LOG_PREFIX = "[pi-lab-test-dialog] "

/** How long a renderer dialog waits for Playwright's page handler before the default. */
export const PAGE_DIALOG_FALLBACK_MS = 5_000

/** One dialog the responder answered in place of a native window. */
export interface TestDialogRecord {
  kind: "messageBox" | "errorBox"
  title: string
  message: string
  buttons: string[]
  /**
   * Chosen button index; `null` for an error box, which has no buttons, and for a
   * renderer dialog the page handler answered, whose choice main does not see.
   */
  response: number | null
  /**
   * `test` when an answer set by the test matched, `page` when Playwright's page
   * dialog handler answered a renderer dialog, else `default`.
   */
  answeredBy: "test" | "default" | "page"
}

/** The test API, also published as `globalThis.piLabTestDialogs`. */
export interface TestDialogResponder {
  /**
   * Answer upcoming message dialogs whose title or message contains `match`
   * (case-insensitive) with button index `response`. Stays active; a later
   * answer for an overlapping match takes precedence.
   */
  answer(match: string, response: number): void
  /** Every dialog answered so far, oldest first. */
  records(): TestDialogRecord[]
}

type MessageDialogs = Pick<Dialog, "showMessageBox" | "showMessageBoxSync" | "showErrorBox">

/** Default button for a dialog no test answer matched (see module doc). */
function defaultResponse(options: MessageBoxSyncOptions): number {
  const buttons = options.buttons ?? []
  const quit = buttons.findIndex((label) => label.startsWith("Quit"))
  if (quit >= 0) return quit
  if (options.cancelId !== undefined) return options.cancelId
  return Math.max(buttons.length - 1, 0)
}

/** Electron's overloads take an optional parent window before the options. */
function messageOptions(args: unknown[]): MessageBoxOptions {
  return (args.length > 1 ? args[1] : args[0]) as MessageBoxOptions
}

/**
 * Replace the message-dialog functions on `dialogs` with test answers, publish
 * the test API on `globalThis.piLabTestDialogs`, and return it. `log` receives
 * one prefixed JSON line per answered dialog.
 */
export function installTestDialogResponder(
  dialogs: MessageDialogs,
  log: (line: string) => void,
): TestDialogResponder {
  const answers: { match: string; response: number }[] = []
  const records: TestDialogRecord[] = []

  const record = (entry: TestDialogRecord) => {
    records.push(entry)
    log(TEST_DIALOG_LOG_PREFIX + JSON.stringify(entry))
  }

  const respond = (options: MessageBoxSyncOptions): number => {
    const title = options.title ?? ""
    const text = `${title}\n${options.message}`.toLowerCase()
    const answer = answers.findLast(({ match }) => text.includes(match.toLowerCase()))
    const response = answer ? answer.response : defaultResponse(options)
    record({
      kind: "messageBox",
      title,
      message: options.message,
      buttons: options.buttons ?? [],
      response,
      answeredBy: answer ? "test" : "default",
    })
    return response
  }

  /** Wait for the page handler to abort a renderer dialog; true if it did in time. */
  const pageAnswered = (signal: AbortSignal): Promise<boolean> =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve(true)
      const timer = setTimeout(() => resolve(false), PAGE_DIALOG_FALLBACK_MS)
      signal.addEventListener("abort", () => {
        clearTimeout(timer)
        resolve(true)
      })
    })

  dialogs.showMessageBox = (async (...args: unknown[]) => {
    const options = messageOptions(args)
    if (options.signal && (await pageAnswered(options.signal))) {
      record({
        kind: "messageBox",
        title: options.title ?? "",
        message: options.message,
        buttons: options.buttons ?? [],
        response: null,
        answeredBy: "page",
      })
      // Electron ignores the result of an aborted box.
      return { response: options.cancelId ?? 0, checkboxChecked: false }
    }
    return { response: respond(options), checkboxChecked: options.checkboxChecked ?? false }
  }) as MessageDialogs["showMessageBox"]
  dialogs.showMessageBoxSync = ((...args: unknown[]) =>
    respond(messageOptions(args))) as MessageDialogs["showMessageBoxSync"]
  dialogs.showErrorBox = (title: string, content: string) =>
    record({
      kind: "errorBox",
      title,
      message: content,
      buttons: [],
      response: null,
      answeredBy: "default",
    })

  const responder: TestDialogResponder = {
    answer: (match, response) => {
      answers.push({ match, response })
    },
    records: () => [...records],
  }
  ;(globalThis as { piLabTestDialogs?: TestDialogResponder }).piLabTestDialogs = responder
  return responder
}
