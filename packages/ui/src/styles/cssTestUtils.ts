/** Read balanced CSS blocks without relying on neighboring comments or rules. */
export function cssBlocks(css: string, header: RegExp): string[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const blocks: string[] = []
  for (const match of source.matchAll(new RegExp(header.source, "g"))) {
    const openingBrace = source.indexOf("{", match.index)
    let depth = 1
    let end = openingBrace + 1
    for (; end < source.length && depth > 0; end += 1) {
      if (source[end] === "{") depth += 1
      if (source[end] === "}") depth -= 1
    }
    blocks.push(source.slice(match.index, end))
  }
  return blocks
}
