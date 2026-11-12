import { afterEach, describe, expect, test } from "vitest"
import { escapeIsFree, overlayIsOpen } from "./keyGuards"

/** Add `element` to the document and return it (removed after each test). */
function mount<T extends HTMLElement>(element: T): T {
  element.dataset.guardTest = "true"
  document.body.appendChild(element)
  return element
}

/** A Cmd+Escape keydown dispatched at `target`, returning the event seen there. */
function escapeAt(target: EventTarget): KeyboardEvent {
  let seen: KeyboardEvent | null = null
  const listen = (event: Event): void => {
    seen = event as KeyboardEvent
  }
  target.addEventListener("keydown", listen)
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", metaKey: true, bubbles: true, cancelable: true }),
  )
  target.removeEventListener("keydown", listen)
  if (!seen) throw new Error("keydown was not dispatched")
  return seen
}

afterEach(() => {
  for (const node of document.querySelectorAll("[data-guard-test]")) node.remove()
})

describe("escapeIsFree", () => {
  test("is true when focus is on the page body and nothing is open", () => {
    expect(escapeIsFree(escapeAt(document.body))).toBe(true)
  })

  test.each([
    [
      "a CodeMirror editor",
      () => {
        const editor = mount(document.createElement("div"))
        editor.className = "cm-editor"
        const content = document.createElement("div")
        content.setAttribute("contenteditable", "true")
        editor.appendChild(content)
        return content
      },
    ],
    [
      "a terminal",
      () => {
        const terminal = mount(document.createElement("div"))
        terminal.className = "xterm"
        const input = document.createElement("textarea")
        terminal.appendChild(input)
        return input
      },
    ],
    ["a text input", () => mount(document.createElement("input"))],
    ["a textarea", () => mount(document.createElement("textarea"))],
    ["a select", () => mount(document.createElement("select"))],
    [
      "a contenteditable",
      () => {
        const editable = mount(document.createElement("div"))
        editable.setAttribute("contenteditable", "true")
        return editable
      },
    ],
  ])("is false when focus is in %s", (_name, make) => {
    expect(escapeIsFree(escapeAt(make()))).toBe(false)
  })

  test.each([
    ['role="dialog"', "role", "dialog"],
    ['role="alertdialog"', "role", "alertdialog"],
    ['role="menu"', "role", "menu"],
    ["aria-modal", "aria-modal", "true"],
  ])("is false while an overlay with %s is open", (_name, attribute, value) => {
    const overlay = mount(document.createElement("div"))
    overlay.setAttribute(attribute, value)
    expect(overlayIsOpen()).toBe(true)
    expect(escapeIsFree(escapeAt(document.body))).toBe(false)
  })

  test("is false while a disclosure popover is expanded", () => {
    const button = mount(document.createElement("button"))
    button.setAttribute("aria-controls", "log")
    button.setAttribute("aria-expanded", "true")
    expect(escapeIsFree(escapeAt(document.body))).toBe(false)
  })

  test("is false when an inner handler already took the key", () => {
    const field = mount(document.createElement("div"))
    field.addEventListener("keydown", (event) => event.preventDefault())
    expect(escapeIsFree(escapeAt(field))).toBe(false)
  })
})
