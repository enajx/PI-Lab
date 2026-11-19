// Menu logic tests: where the reply box sends while a menu shows, and the
// sending of menu choices. The server here is a fake that follows the
// contract of terminal.chooseOption (apps/desktop/src/main/trpc/terminal/terminal.ts):
// once per message ID, "menu-changed" when the menu on screen is another one.
import { describe, expect, it } from "vitest"
import type { ChooseOptionResult, MenuAction, TerminalMenu } from "./menu"
import { choiceNotice, MenuOutbox, replyTarget } from "./menu"

function menu(options: Array<Partial<TerminalMenu["options"][number]> & { key: string }>) {
  return {
    id: "menu-1",
    question: "Which colour do you prefer?",
    multiSelect: false,
    tabs: null,
    options: options.map((option) => ({
      label: `Option ${option.key}`,
      detail: null,
      cursor: false,
      checked: null,
      freeText: false,
      ...option,
    })),
  } satisfies TerminalMenu
}

describe("replyTarget", () => {
  it("sends a plain message when no menu shows", () => {
    expect(replyTarget(null)).toEqual({ kind: "message" })
  })

  it("sends typed text to the menu's free-text option", () => {
    const shown = menu([{ key: "1" }, { key: "2", label: "Type something.", freeText: true }])
    expect(replyTarget(shown)).toEqual({ kind: "menu-text", option: "2" })
  })

  it("turns the reply box off with a hint when the menu takes no typed text", () => {
    expect(replyTarget(menu([{ key: "1" }, { key: "2" }]))).toEqual({
      kind: "off",
      hint: "Tap an option above to answer.",
    })
  })
})

describe("MenuOutbox", () => {
  /** A fake terminal.chooseOption: records message IDs, fails the first `failures` calls. */
  function fakeServer(failures: number, result: ChooseOptionResult) {
    const calls: Array<{ messageId: string; menuId: string; action: MenuAction }> = []
    let left = failures
    const choose = async (input: { messageId: string; menuId: string; action: MenuAction }) => {
      calls.push(input)
      if (left > 0) {
        left -= 1
        throw new Error("connection lost")
      }
      return result
    }
    return { calls, choose }
  }

  it("a resend after a failure keeps the message ID; the next choice gets a new one", async () => {
    const ids = ["id-1", "id-2", "id-3"]
    const outbox = new MenuOutbox(() => ids.shift() ?? "no-id-left")
    const server = fakeServer(1, { status: "sent", finished: false })
    const tick = { kind: "choose", option: "2" } as const
    await expect(outbox.send("menu-1", tick, server.choose)).rejects.toThrow("connection lost")
    expect(await outbox.send("menu-1", tick, server.choose)).toEqual({
      status: "sent",
      finished: false,
    })
    // Ticking the same option again (to untick it) is a new choice.
    await outbox.send("menu-1", tick, server.choose)
    expect(server.calls.map((call) => call.messageId)).toEqual(["id-1", "id-1", "id-2"])
  })
})

describe("choiceNotice", () => {
  it("tells the user when the menu changed and nothing was sent", () => {
    expect(choiceNotice({ status: "menu-changed" })).toBe(
      "The agent's menu changed before your choice arrived. Nothing was sent.",
    )
    expect(choiceNotice({ status: "sent", finished: true })).toBeNull()
    expect(choiceNotice({ status: "duplicate" })).toBeNull()
  })
})
