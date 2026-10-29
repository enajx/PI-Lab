import type { BaseWindow, Dialog } from "electron"
import { expect, test, vi } from "vitest"
import {
  installTestDialogResponder,
  PAGE_DIALOG_FALLBACK_MS,
  TEST_DIALOG_LOG_PREFIX,
} from "./testDialogs"

type MessageDialogs = Pick<Dialog, "showMessageBox" | "showMessageBoxSync" | "showErrorBox">

/** Stand-in for Electron's `dialog`: any call that reaches it is a real native dialog. */
function nativeDialogs(): MessageDialogs {
  const fail = () => {
    throw new Error("a real native dialog was shown")
  }
  return { showMessageBox: fail, showMessageBoxSync: fail, showErrorBox: fail } as MessageDialogs
}

function install() {
  const dialogs = nativeDialogs()
  const lines: string[] = []
  const responder = installTestDialogResponder(dialogs, (line) => lines.push(line))
  return { dialogs, lines, responder }
}

test("an answer set by the test is used for a matching dialog and recorded", async () => {
  const { dialogs, lines, responder } = install()
  responder.answer("Work is still running", 1)
  const window = {} as BaseWindow
  const result = await dialogs.showMessageBox(window, {
    title: "Work is still running",
    message: "1 terminal is still running a command.",
    buttons: ["Quit and stop terminals", "Keep running in background", "Cancel"],
    cancelId: 2,
  })
  expect(result).toEqual({ response: 1, checkboxChecked: false })
  expect(responder.records()).toEqual([
    {
      kind: "messageBox",
      title: "Work is still running",
      message: "1 terminal is still running a command.",
      buttons: ["Quit and stop terminals", "Keep running in background", "Cancel"],
      response: 1,
      answeredBy: "test",
    },
  ])
  expect(lines).toHaveLength(1)
  expect(lines[0]?.startsWith(TEST_DIALOG_LOG_PREFIX)).toBe(true)
  expect(JSON.parse(lines[0]?.slice(TEST_DIALOG_LOG_PREFIX.length) ?? "")).toEqual(
    responder.records()[0],
  )
})

test("an answer can match the message instead of the title", () => {
  const { dialogs, responder } = install()
  responder.answer("could not install", 0)
  expect(
    dialogs.showMessageBoxSync({
      message: "Could not install the pilab command",
      buttons: ["OK", "Retry"],
      cancelId: 1,
    }),
  ).toBe(0)
})

test("unset quit and stop confirmations default to the button that completes quitting", async () => {
  const { dialogs, responder } = install()
  const choose = await dialogs.showMessageBox({
    title: "Quit PI Lab?",
    message: "Quit PI Lab?",
    buttons: ["Cancel", "Move to background", "Quit"],
    cancelId: 0,
  })
  const confirm = await dialogs.showMessageBox({
    title: "Work is still running",
    message: "1 agent is still running.",
    buttons: ["Quit and stop agents", "Cancel"],
    cancelId: 1,
  })
  expect([choose.response, confirm.response]).toEqual([2, 0])
  expect(responder.records().map((record) => record.answeredBy)).toEqual(["default", "default"])
})

test("other unset dialogs default to cancelId, or to the last button without one", async () => {
  const { dialogs } = install()
  const withCancel = await dialogs.showMessageBox({
    message: "Delete it?",
    buttons: ["Delete", "Keep", "Cancel"],
    cancelId: 1,
  })
  const withoutCancel = dialogs.showMessageBoxSync({
    message: "Pick one",
    buttons: ["First", "Second", "Third"],
  })
  const noButtons = await dialogs.showMessageBox({ type: "info", message: "Installed" })
  expect([withCancel.response, withoutCancel, noButtons.response]).toEqual([1, 2, 0])
})

test("an error box is recorded and printed instead of shown", () => {
  const { dialogs, lines, responder } = install()
  dialogs.showErrorBox("Could not quit PI Lab", "The app remains open.")
  expect(responder.records()).toEqual([
    {
      kind: "errorBox",
      title: "Could not quit PI Lab",
      message: "The app remains open.",
      buttons: [],
      response: null,
      answeredBy: "default",
    },
  ])
  expect(lines).toHaveLength(1)
})

test("a renderer alert or confirm is left to Playwright's page dialog handler", async () => {
  const { dialogs, responder } = install()
  const abort = new AbortController()
  const pending = dialogs.showMessageBox({
    message: "Forget every project?",
    buttons: ["OK", "Cancel"],
    cancelId: 1,
    signal: abort.signal,
  })
  await Promise.resolve()
  expect(responder.records()).toEqual([])
  // Playwright accepting or dismissing the page dialog makes Electron abort the box.
  abort.abort()
  await pending
  expect(responder.records()).toEqual([
    {
      kind: "messageBox",
      title: "",
      message: "Forget every project?",
      buttons: ["OK", "Cancel"],
      response: null,
      answeredBy: "page",
    },
  ])
})

test("a renderer dialog nobody handles gets the default answer after a bounded wait", async () => {
  vi.useFakeTimers()
  const { dialogs, responder } = install()
  const pending = dialogs.showMessageBox({
    message: "Leave site?",
    buttons: ["OK", "Cancel"],
    cancelId: 1,
    signal: new AbortController().signal,
  })
  await vi.advanceTimersByTimeAsync(PAGE_DIALOG_FALLBACK_MS)
  expect((await pending).response).toBe(1)
  expect(responder.records().map((record) => record.answeredBy)).toEqual(["default"])
  vi.useRealTimers()
})
