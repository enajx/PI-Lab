import { cn } from "@pi-lab/ui"
import { memo } from "react"
import ReactMarkdown, { type Components, type Options } from "react-markdown"
import remarkGfm from "remark-gfm"

const remarkPlugins: Options["remarkPlugins"] = [remarkGfm]

const markdownComponents: Components = {
  h1: ({ className, ...props }) => (
    <h1
      className={cn("mt-4 mb-1 font-semibold text-foreground text-lg first:mt-0", className)}
      {...props}
    />
  ),
  h2: ({ className, ...props }) => (
    <h2
      className={cn("mt-4 mb-1 font-semibold text-base text-foreground first:mt-0", className)}
      {...props}
    />
  ),
  h3: ({ className, ...props }) => (
    <h3
      className={cn("mt-3 mb-1 font-medium text-foreground text-sm first:mt-0", className)}
      {...props}
    />
  ),
  p: ({ className, ...props }) => <p className={cn("leading-relaxed", className)} {...props} />,
  ul: ({ className, ...props }) => (
    <ul className={cn("ml-4 list-disc space-y-1", className)} {...props} />
  ),
  ol: ({ className, ...props }) => (
    <ol className={cn("ml-4 list-decimal space-y-1", className)} {...props} />
  ),
  li: ({ className, ...props }) => <li className={cn("leading-relaxed", className)} {...props} />,
  a: ({ className, ...props }) => (
    <a
      className={cn("text-accent-brand underline underline-offset-2", className)}
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  code: ({ className, ...props }) => (
    <code
      className={cn("rounded bg-accent/60 px-1 py-0.5 font-mono text-[0.85em]", className)}
      {...props}
    />
  ),
  pre: ({ className, ...props }) => (
    <pre
      className={cn("overflow-x-auto rounded-md bg-accent/40 p-3 font-mono text-xs", className)}
      {...props}
    />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn("border-border border-l-2 pl-3 text-muted-foreground italic", className)}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => <hr className={cn("border-border", className)} {...props} />,
  table: ({ className, ...props }) => (
    <table className={cn("w-full border-collapse text-xs", className)} {...props} />
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn("border border-border px-2 py-1 text-left font-medium", className)}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td className={cn("border border-border px-2 py-1", className)} {...props} />
  ),
}

/**
 * Lightweight markdown renderer for the doc panels (RESEARCH.md, TODO.md). The
 * tree has no Tailwind `typography`/`prose` plugin, so element styling is mapped
 * explicitly here — kept deliberately small and readable rather than a full
 * prose theme. GitHub-flavoured markdown (tables, task lists, strikethrough) is
 * enabled via `remark-gfm` so a research doc's checklists and tables render.
 *
 * Text is selectable (`select-text`) — the surrounding app sets `user-select:
 * none` on the body, and a doc the user wants to read should
 * be copyable.
 */
export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <div
      data-testid="markdown"
      className="cursor-text select-text space-y-3 text-foreground/90 text-sm leading-relaxed"
    >
      <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  )
})
