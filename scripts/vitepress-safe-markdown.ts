/**
 * VitePress feeds Markdown's raw HTML tokens into Vue's template compiler. A
 * harmless instruction such as `#<number>` therefore becomes an unclosed Vue
 * element and aborts the entire docs build. Keep source Markdown literal and
 * turn only unclosed inline HTML-like tokens back into text at render time.
 */

interface MarkdownToken {
  children?: MarkdownToken[]
  content: string
  type: string
}

interface MarkdownItCore {
  ruler: {
    after(
      afterName: string,
      ruleName: string,
      rule: (state: { tokens: MarkdownToken[] }) => void,
    ): void
  }
}

const VOID_HTML_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
])

const OPENING_TAG = /^<([A-Za-z][\w:-]*)(?:\s[^<>]*?)?>$/
const CLOSING_TAG = /^<\/([A-Za-z][\w:-]*)\s*>$/
const SELF_CLOSING_TAG = /^<([A-Za-z][\w:-]*)(?:\s[^<>]*?)?\/\s*>$/

function visitTokens(tokens: MarkdownToken[], callback: (token: MarkdownToken) => void): void {
  for (const token of tokens) {
    callback(token)
    if (token.children) visitTokens(token.children, callback)
  }
}

function htmlTagContent(token: MarkdownToken): string | null {
  return token.type === "html_inline" || token.type === "html_block" ? token.content.trim() : null
}

/** Escape only raw tags that have no matching pair in this rendered Markdown document. */
export function escapeUnclosedMarkdownHtml(tokens: MarkdownToken[]): void {
  const openingTags = new Set<string>()
  const closingTags = new Set<string>()
  visitTokens(tokens, (token) => {
    const content = htmlTagContent(token)
    if (!content || SELF_CLOSING_TAG.test(content)) return
    const opening = content.match(OPENING_TAG)
    if (opening?.[1]) openingTags.add(opening[1].toLowerCase())
    const closing = content.match(CLOSING_TAG)
    if (closing?.[1]) closingTags.add(closing[1].toLowerCase())
  })

  visitTokens(tokens, (token) => {
    const content = htmlTagContent(token)
    if (!content || SELF_CLOSING_TAG.test(content)) return
    const opening = content.match(OPENING_TAG)
    const openingTag = opening?.[1]?.toLowerCase()
    if (openingTag && !VOID_HTML_TAGS.has(openingTag) && !closingTags.has(openingTag)) {
      token.type = "text"
      return
    }
    const closing = content.match(CLOSING_TAG)
    const closingTag = closing?.[1]?.toLowerCase()
    if (closingTag && !openingTags.has(closingTag)) token.type = "text"
  })
}

/** Install the VitePress Markdown-core transform after inline tokens have been parsed. */
export function installSafeMarkdownTransform(markdown: MarkdownItCore): void {
  markdown.core.ruler.after("inline", "pi-lab-escape-unclosed-html", (state) => {
    escapeUnclosedMarkdownHtml(state.tokens)
  })
}
