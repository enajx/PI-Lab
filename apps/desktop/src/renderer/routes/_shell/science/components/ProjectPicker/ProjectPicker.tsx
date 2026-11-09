/** One project the picker offers. */
export interface ProjectPickerOption {
  id: string
  name: string
}

interface ProjectPickerProps {
  /** Stable test id (e.g. `tasks-project-select`). */
  testId: string
  /** Accessible name of the select. */
  label: string
  /** Hover and feature-help text. */
  help: string
  /** The chosen project id; "" means the "All projects" option when `allLabel` is set. */
  value: string
  projects: ProjectPickerOption[]
  /** Label of a leading "all projects" option with value "", or null for no such option. */
  allLabel: string | null
  onChange: (projectId: string) => void
}

/**
 * Project select for a science tab's top bar (ScienceTabShell `actions`), styled
 * like the LaTeX Editor's. The caller owns the value, remembering it and the address.
 */
export function ProjectPicker({
  testId,
  label,
  help,
  value,
  projects,
  allLabel,
  onChange,
}: ProjectPickerProps) {
  return (
    <select
      data-testid={testId}
      aria-label={label}
      title={help}
      data-feature-label={label}
      data-feature-help={help}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 max-w-56 rounded-md border border-border bg-background px-2 text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-ring"
    >
      {allLabel === null ? null : <option value="">{allLabel}</option>}
      {projects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.name}
        </option>
      ))}
    </select>
  )
}
