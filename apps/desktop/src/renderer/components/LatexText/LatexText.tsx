import { Fragment, type ReactNode } from "react"

/**
 * The LaTeX logo as it is usually typeset: a small raised "A" tucked under the
 * "L", and a lowered "E" between "T" and "X". Sized in `em`, so it follows the
 * surrounding font. Screen readers read "LaTeX".
 */
export function LatexLogo() {
  return (
    <span
      data-testid="latex-logo"
      role="img"
      aria-label="LaTeX"
      className="inline-block whitespace-nowrap"
    >
      L
      <span
        aria-hidden
        className="relative -top-[0.22em] -ml-[0.32em] -mr-[0.12em] text-[0.75em] uppercase"
      >
        a
      </span>
      T
      <span aria-hidden className="relative top-[0.22em] -mx-[0.12em]">
        E
      </span>
      X
    </span>
  )
}

/** Render `text` with every "LaTeX" drawn as {@link LatexLogo}; other text is unchanged. */
export function LatexText({ text }: { text: string }) {
  const nodes: ReactNode[] = []
  // Keys are character offsets in `text`, which are stable for a given string.
  let offset = 0
  for (const [index, part] of text.split("LaTeX").entries()) {
    if (index > 0) {
      nodes.push(<LatexLogo key={`logo-${offset}`} />)
      offset += "LaTeX".length
    }
    if (part) nodes.push(<Fragment key={`text-${offset}`}>{part}</Fragment>)
    offset += part.length
  }
  return <>{nodes}</>
}
