// The session screen's menu buttons: the server reads the agent's menu from
// its screen (`menu` on terminal.screenText) and carries out a choice
// (terminal.chooseOption). Nothing here reads terminal text.

import type {
  ChooseOptionResult,
  MenuAction,
  TerminalMenu,
} from "../../../desktop/src/shared/clientApi"

export type { ChooseOptionResult, MenuAction, TerminalMenu }

/** Sends one menu choice with `terminal.chooseOption`. */
export type ChooseOption = (input: {
  messageId: string
  menuId: string
  action: MenuAction
}) => Promise<ChooseOptionResult>

/**
 * Where the reply box sends: a plain message when no menu shows; typed text
 * to the menu's free-text option (the one under the cursor, else the first);
 * off, with a hint, when the menu takes no typed text, so text and Enter
 * never land in a menu by accident.
 */
export type ReplyTarget =
  | { kind: "message" }
  | { kind: "menu-text"; option: string }
  | { kind: "off"; hint: string }

export function replyTarget(menu: TerminalMenu | null): ReplyTarget {
  if (menu === null) return { kind: "message" }
  const freeText = menu.options.filter((option) => option.freeText)
  const option = freeText.find((candidate) => candidate.cursor) ?? freeText[0]
  if (option === undefined) return { kind: "off", hint: "Tap an option above to answer." }
  return { kind: "menu-text", option: option.key }
}

/**
 * Menu choices keep their message ID until the server answered, so sending
 * the same choice again after a failed or lost reply uses the same ID and the
 * server writes it once. Any choice after an answered one gets a new ID (a
 * second tap on a multi-select option unticks it).
 */
export class MenuOutbox {
  readonly #newId: () => string
  #unsent: { messageId: string; menuId: string; action: MenuAction } | null = null

  constructor(newId: () => string) {
    this.#newId = newId
  }

  async send(
    menuId: string,
    action: MenuAction,
    choose: ChooseOption,
  ): Promise<ChooseOptionResult> {
    const unsent = this.#unsent
    const same =
      unsent !== null &&
      unsent.menuId === menuId &&
      JSON.stringify(unsent.action) === JSON.stringify(action)
    const choice = same ? unsent : { messageId: this.#newId(), menuId, action }
    this.#unsent = choice
    const result = await choose(choice)
    if (this.#unsent === choice) this.#unsent = null
    return result
  }
}

/** What to tell the user after a choice, or null when there is nothing to tell. */
export function choiceNotice(result: ChooseOptionResult): string | null {
  return result.status === "menu-changed"
    ? "The agent's menu changed before your choice arrived. Nothing was sent."
    : null
}
