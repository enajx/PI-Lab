/** The four task stages presented by PI Lab. */
export type TaskStatus = "backlog" | "planned" | "wip" | "done"

/** A Markdown heading that owns a task in the source document. */
export interface TaskHeading {
  /** Revision-local key used when moving a task to this heading. */
  key: string
  label: string
  /** Ancestor labels from the document root through this heading. */
  path: string[]
}

/** Exact location of a task block in the source Markdown. */
export interface TaskSourceRange {
  /** UTF-16 string offset, suitable for JavaScript string slicing. */
  start: number
  /** Exclusive UTF-16 string offset. */
  end: number
  /** One-based source line. */
  line: number
}

/** One task projected from a project's root TODO Markdown file. */
export interface ScienceTask {
  /** Stable when an id exists; revision-local until the first mutation otherwise. */
  key: string
  id: string | null
  projectId: string
  projectName: string
  relPath: string
  revision: string
  title: string
  details: string
  status: TaskStatus
  priority: string | null
  labels: string[]
  owner: string | null
  heading: TaskHeading | null
  /** Selected board column containing this task, or null when outside that depth. */
  boardHeadingKey: string | null
  source: TaskSourceRange
}

/** Discovery result for one project's root TODO Markdown source. */
export interface TaskSource {
  projectId: string
  projectName: string
  state: "ready" | "missing" | "ambiguous" | "error"
  relPath: string | null
  candidates: string[]
  revision: string | null
  /** Every document heading, including sections that currently contain no tasks. */
  headings: TaskHeading[]
  /** Headings at the single deterministic depth used for the heading board. */
  boardHeadings: TaskHeading[]
  error?: string
}

/** Aggregate response for the Tasks screen. */
export interface TaskListing {
  sources: TaskSource[]
  tasks: ScienceTask[]
}

/** Public selector accepted by task mutations. */
export type TaskSelector =
  | { id: string }
  | { key: string }
  | {
      /** Revision-local source offset for a task that does not yet have an id. */
      sourceStart: number
    }
