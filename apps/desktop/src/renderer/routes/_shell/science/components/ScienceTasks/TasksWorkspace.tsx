import { fuzzyMatch } from "@pi-lab/shared/search/fuzzy"
import { Button, cn, Input } from "@pi-lab/ui"
import {
  Bot,
  Check,
  ChevronRight,
  Columns3,
  Eye,
  EyeOff,
  Heading2,
  List,
  ListTree,
  Pencil,
  Plus,
  Search,
  SquareKanban,
  Trash2,
  Ungroup,
  X,
} from "lucide-react"
import { type DragEvent, type FormEvent, type ReactNode, useMemo, useState } from "react"
import { translateKnownError } from "../../../../../i18n/errors"
import { useInterfaceLanguage, useTranslate } from "../../../../../i18n/language"

export type TaskStatus = "backlog" | "planned" | "wip" | "done"

export interface TaskHeading {
  key: string
  label: string
  path: string[]
}

export interface TaskRecord {
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
  boardHeadingKey: string | null
  source: { start: number; end: number; line: number }
}

export interface TaskSource {
  projectId: string
  projectName: string
  state: "ready" | "missing" | "ambiguous" | "error"
  relPath: string | null
  candidates: string[]
  revision: string | null
  headings: TaskHeading[]
  boardHeadings: TaskHeading[]
  error?: string
}

export interface TaskDraft {
  title: string
  details: string
  status: TaskStatus
  priority: string | null
  labels: string[]
  owner: string | null
}

export interface AgentChoice {
  id: string
  label: string
}

interface TasksWorkspaceProps {
  tasks: TaskRecord[]
  sources: TaskSource[]
  agents: AgentChoice[]
  defaultAgentId: string
  busy?: boolean
  error?: string | null
  onCreate: (projectId: string, relPath: string, draft: TaskDraft) => Promise<void>
  onUpdate: (task: TaskRecord, draft: TaskDraft) => Promise<void>
  onDelete: (task: TaskRecord) => Promise<void>
  onMove: (
    task: TaskRecord,
    target: { kind: "status"; status: TaskStatus } | { kind: "heading"; headingKey: string },
  ) => Promise<void>
  onRun: (task: TaskRecord, agentId: string, prompt: string) => Promise<void>
}

type ViewMode = "list" | "board"
type ListMode = "plain" | "headings"
type BoardMode = "headings" | "status"

const STATUS_ORDER: TaskStatus[] = ["backlog", "planned", "wip", "done"]
const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog",
  planned: "Planned",
  wip: "WIP",
  done: "Done",
}

interface KanbanLane {
  key: "todo" | "in-progress" | "done"
  title: string
  statuses: TaskStatus[]
  destination: TaskStatus
}

const KANBAN_LANES: KanbanLane[] = [
  {
    key: "todo",
    title: "Todo",
    statuses: ["backlog", "planned"],
    destination: "planned",
  },
  {
    key: "in-progress",
    title: "In Progress",
    statuses: ["wip"],
    destination: "wip",
  },
  {
    key: "done",
    title: "Done",
    statuses: ["done"],
    destination: "done",
  },
]

function taskMatches(
  task: TaskRecord,
  filters: {
    query: string
    projectId: string
    status: string
    priority: string
    owner: string
    label: string
  },
): boolean {
  if (filters.projectId && task.projectId !== filters.projectId) return false
  if (filters.status && task.status !== filters.status) return false
  if (filters.priority && task.priority !== filters.priority) return false
  if (filters.owner && task.owner !== filters.owner) return false
  if (filters.label && !task.labels.includes(filters.label)) return false
  const query = filters.query.trim().toLocaleLowerCase()
  if (!query) return true
  const searchable = [
    task.title,
    task.details,
    task.projectName,
    task.heading?.label,
    task.owner,
    ...task.labels,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
  return fuzzyMatch(query, searchable) !== null
}

export function TasksWorkspace({
  tasks,
  sources,
  agents,
  defaultAgentId,
  busy = false,
  error,
  onCreate,
  onUpdate,
  onDelete,
  onMove,
  onRun,
}: TasksWorkspaceProps) {
  const t = useTranslate()
  const [language] = useInterfaceLanguage()
  const [view, setView] = useState<ViewMode>("list")
  const [listMode, setListMode] = useState<ListMode>("plain")
  const [boardMode, setBoardMode] = useState<BoardMode>("headings")
  const [query, setQuery] = useState("")
  const [projectId, setProjectId] = useState("")
  const [status, setStatus] = useState("")
  const [priority, setPriority] = useState("")
  const [owner, setOwner] = useState("")
  const [label, setLabel] = useState("")
  const [showDone, setShowDone] = useState(false)
  const [editing, setEditing] = useState<TaskRecord | null>(null)
  const [creating, setCreating] = useState(false)
  const [running, setRunning] = useState<TaskRecord | null>(null)
  const [draggedKey, setDraggedKey] = useState<string | null>(null)
  const [headingSelections, setHeadingSelections] = useState<Record<string, string[]>>({})

  const writableSources = sources.filter(
    (source) => source.state === "ready" || source.state === "missing",
  )
  const filtered = useMemo(
    () =>
      tasks.filter(
        (task) =>
          (showDone || task.status !== "done") &&
          taskMatches(task, { query, projectId, status, priority, owner, label }),
      ),
    [tasks, showDone, query, projectId, status, priority, owner, label],
  )
  const priorities = unique(tasks.map((task) => task.priority).filter(isString))
  const owners = unique(tasks.map((task) => task.owner).filter(isString))
  const labels = unique(tasks.flatMap((task) => task.labels))
  const dragged = draggedKey ? (tasks.find((task) => task.key === draggedKey) ?? null) : null

  const dropOn = (
    event: DragEvent,
    target: { kind: "status"; status: TaskStatus } | { kind: "heading"; headingKey: string },
  ) => {
    event.preventDefault()
    if (dragged && !alreadyInStatusLane(dragged.status, target)) void onMove(dragged, target)
    setDraggedKey(null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="tasks-workspace">
      <div className="flex flex-wrap items-center gap-2 border-border border-b px-4 py-2">
        <select
          data-testid="tasks-project-filter"
          aria-label={t("Project filter")}
          title={t("Filter tasks by project")}
          data-feature-help={t("Filter tasks by project")}
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          className="h-8 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="">{t("All projects")}</option>
          {sources.map((source) => (
            <option key={source.projectId} value={source.projectId}>
              {source.projectName}
            </option>
          ))}
        </select>
        <div className="relative min-w-44 flex-1 sm:max-w-xs">
          <Search
            aria-hidden
            className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            data-testid="tasks-search"
            aria-label={t("Search tasks")}
            title={t("Search task titles, details, projects, headings, owners, and labels")}
            data-feature-help={t(
              "Search task titles, details, projects, headings, owners, and labels",
            )}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("Search tasks")}
            className="h-8 pl-8"
          />
        </div>
        <FilterSelect
          label={t("All statuses")}
          description={t("Filter tasks by status")}
          value={status}
          values={STATUS_ORDER}
          render={(value) => t(STATUS_LABEL[value as TaskStatus])}
          onChange={setStatus}
        />
        <FilterSelect
          label={t("All priorities")}
          description={t("Filter tasks by priority")}
          value={priority}
          values={priorities}
          onChange={setPriority}
        />
        <FilterSelect
          label={t("All owners")}
          description={t("Filter tasks by owner")}
          value={owner}
          values={owners}
          onChange={setOwner}
        />
        <FilterSelect
          label={t("All labels")}
          description={t("Filter tasks by label")}
          value={label}
          values={labels}
          onChange={setLabel}
        />
        <Button
          variant="ghost"
          size="sm"
          aria-label={t(showDone ? "Hide done" : "Show done")}
          data-feature-help={t(
            showDone
              ? "Hide completed tasks from this view"
              : "Reveal completed tasks in this view",
          )}
          aria-pressed={showDone}
          onClick={() => setShowDone((current) => !current)}
          className="h-8 gap-1.5 text-muted-foreground"
        >
          {showDone ? <EyeOff /> : <Eye />}
          {t(showDone ? "Hide done" : "Show done")}
        </Button>
        <div
          data-testid="tasks-toolbar-controls"
          className="ml-auto flex shrink-0 items-center gap-1.5"
        >
          <fieldset
            aria-label={t("Grouping")}
            data-testid="tasks-group-toggle"
            className="flex rounded-md border border-border bg-muted/30 p-0.5"
          >
            {view === "list" ? (
              <>
                <ViewButton
                  active={listMode === "plain"}
                  label={t("No grouping")}
                  description={t("Show all tasks in one flat list")}
                  onClick={() => setListMode("plain")}
                >
                  <Ungroup />
                </ViewButton>
                <ViewButton
                  active={listMode === "headings"}
                  label={t("Group by headings")}
                  description={t("Organize tasks using the TODO Markdown headings")}
                  onClick={() => setListMode("headings")}
                >
                  <ListTree />
                </ViewButton>
              </>
            ) : (
              <>
                <ViewButton
                  active={boardMode === "headings"}
                  label={t("Group by headings")}
                  description={t("Organize tasks using the TODO Markdown headings")}
                  onClick={() => setBoardMode("headings")}
                >
                  <Heading2 />
                </ViewButton>
                <ViewButton
                  active={boardMode === "status"}
                  label={t("Group by Kanban")}
                  description={t("Organize tasks into Todo, In Progress, and Done")}
                  onClick={() => setBoardMode("status")}
                >
                  <SquareKanban />
                </ViewButton>
              </>
            )}
          </fieldset>
          <fieldset
            aria-label={t("View")}
            data-testid="tasks-view-toggle"
            className="flex rounded-md border border-border bg-muted/30 p-0.5"
          >
            <ViewButton
              active={view === "list"}
              label={t("List view")}
              description={t("Show tasks as compact rows")}
              onClick={() => setView("list")}
            >
              <List />
            </ViewButton>
            <ViewButton
              active={view === "board"}
              label={t("Kanban view")}
              description={t("Show tasks as draggable columns")}
              onClick={() => setView("board")}
            >
              <Columns3 />
            </ViewButton>
          </fieldset>
        </div>
        <Button
          size="sm"
          className="h-8 gap-1.5"
          disabled={writableSources.length === 0 || busy}
          data-feature-help={t("Create a task in a project's TODO Markdown")}
          onClick={() => setCreating(true)}
        >
          <Plus className="size-4" />
          {t("New task")}
        </Button>
      </div>

      {error ? <ErrorBanner message={translateKnownError(language, error)} /> : null}
      <SourceNotices sources={sources} />

      <div className="min-h-0 flex-1 overflow-auto">
        {filtered.length === 0 && view === "list" ? (
          <div data-testid="tasks-empty" className="grid h-full place-items-center p-8 text-center">
            <div>
              <p className="font-medium text-sm">{t("No tasks found")}</p>
              <p className="mt-1 text-muted-foreground text-xs">
                {t("Tasks remain ordinary checkbox items in each project's TODO Markdown.")}
              </p>
            </div>
          </div>
        ) : view === "list" && listMode === "plain" ? (
          <TaskList
            tasks={filtered}
            onEdit={setEditing}
            onRun={setRunning}
            onToggle={(task) =>
              void onUpdate(task, {
                ...taskToDraft(task),
                status: task.status === "done" ? "planned" : "done",
              })
            }
          />
        ) : view === "list" ? (
          <HeadingTaskList
            tasks={filtered}
            sources={sources.filter((source) => !projectId || source.projectId === projectId)}
            showProjectHeadings={!projectId}
            onEdit={setEditing}
            onRun={setRunning}
            onToggle={(task) =>
              void onUpdate(task, {
                ...taskToDraft(task),
                status: task.status === "done" ? "planned" : "done",
              })
            }
          />
        ) : boardMode === "status" ? (
          <StatusBoard
            tasks={filtered}
            draggedKey={draggedKey}
            onDrag={setDraggedKey}
            onDrop={dropOn}
            onEdit={setEditing}
          />
        ) : (
          <HeadingBoard
            tasks={filtered}
            sources={sources.filter((source) => !projectId || source.projectId === projectId)}
            selections={headingSelections}
            onSelectionChange={(selectedProjectId, keys) =>
              setHeadingSelections((current) => ({ ...current, [selectedProjectId]: keys }))
            }
            draggedKey={draggedKey}
            onDrag={setDraggedKey}
            onDrop={dropOn}
            onEdit={setEditing}
          />
        )}
      </div>

      {creating ? (
        <TaskEditorDialog
          sources={writableSources}
          initialProjectId={projectId}
          busy={busy}
          onClose={() => setCreating(false)}
          onSave={async (selectedProjectId, relPath, draft) => {
            await onCreate(selectedProjectId, relPath, draft)
            setCreating(false)
          }}
        />
      ) : null}
      {editing ? (
        <TaskEditorDialog
          task={editing}
          sources={sources}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={async (_projectId, _relPath, draft) => {
            await onUpdate(editing, draft)
            setEditing(null)
          }}
          onDelete={async () => {
            await onDelete(editing)
            setEditing(null)
          }}
        />
      ) : null}
      {running ? (
        <RunTaskDialog
          task={running}
          agents={agents}
          defaultAgentId={defaultAgentId}
          busy={busy}
          onClose={() => setRunning(null)}
          onRun={async (agentId, prompt) => {
            await onRun(running, agentId, prompt)
            setRunning(null)
          }}
        />
      ) : null}
    </div>
  )
}

function TaskList({
  tasks,
  onEdit,
  onRun,
  onToggle,
}: {
  tasks: TaskRecord[]
  onEdit: (task: TaskRecord) => void
  onRun: (task: TaskRecord) => void
  onToggle: (task: TaskRecord) => void
}) {
  return (
    <div className="divide-y divide-border" data-testid="tasks-list">
      <TaskRows tasks={tasks} onEdit={onEdit} onRun={onRun} onToggle={onToggle} />
    </div>
  )
}

function HeadingTaskList({
  tasks,
  sources,
  showProjectHeadings,
  onEdit,
  onRun,
  onToggle,
}: {
  tasks: TaskRecord[]
  sources: TaskSource[]
  showProjectHeadings: boolean
  onEdit: (task: TaskRecord) => void
  onRun: (task: TaskRecord) => void
  onToggle: (task: TaskRecord) => void
}) {
  const t = useTranslate()
  return (
    <div data-testid="tasks-heading-list">
      {sources.map((source) => {
        const projectTasks = tasks.filter((task) => task.projectId === source.projectId)
        if (projectTasks.length === 0) return null
        const taskGroups = groupBy(projectTasks, (task) => task.heading?.key ?? "ungrouped")
        const groups = source.headings
          .map((heading) => ({
            key: heading.key,
            title: heading.path.join(" / "),
            tasks: taskGroups.get(heading.key) ?? [],
          }))
          .filter((group) => group.tasks.length > 0)
        const knownHeadingKeys = new Set(source.headings.map((heading) => heading.key))
        for (const task of projectTasks) {
          const heading = task.heading
          if (!heading || knownHeadingKeys.has(heading.key)) continue
          knownHeadingKeys.add(heading.key)
          groups.push({
            key: heading.key,
            title: heading.path.join(" / "),
            tasks: taskGroups.get(heading.key) ?? [],
          })
        }
        const ungrouped = taskGroups.get("ungrouped")
        if (ungrouped?.length) {
          groups.push({ key: "ungrouped", title: t("Ungrouped"), tasks: ungrouped })
        }
        return (
          <section
            key={source.projectId}
            data-testid="task-list-project"
            aria-label={source.projectName}
          >
            {showProjectHeadings ? (
              <h2 className="border-border border-b bg-muted/40 px-4 py-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                {source.projectName}
              </h2>
            ) : null}
            {groups.map((group) => (
              <section key={group.key} data-testid="task-list-group">
                <h3
                  data-testid="task-list-heading"
                  className="border-border border-b bg-muted/20 px-4 py-2 font-medium text-xs"
                >
                  {group.title}
                </h3>
                <div className="divide-y divide-border">
                  <TaskRows tasks={group.tasks} onEdit={onEdit} onRun={onRun} onToggle={onToggle} />
                </div>
              </section>
            ))}
          </section>
        )
      })}
    </div>
  )
}

function TaskRows({
  tasks,
  onEdit,
  onRun,
  onToggle,
}: {
  tasks: TaskRecord[]
  onEdit: (task: TaskRecord) => void
  onRun: (task: TaskRecord) => void
  onToggle: (task: TaskRecord) => void
}) {
  const t = useTranslate()
  return tasks.map((task) => (
    <article
      key={task.key}
      data-testid="task-row"
      className="group flex items-start gap-3 px-4 py-3 hover:bg-muted/30"
    >
      <button
        type="button"
        aria-label={t(task.status === "done" ? "Mark planned" : "Mark done")}
        data-feature-help={t("Update this item's checkbox state in the project's TODO Markdown")}
        onClick={() => onToggle(task)}
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
          task.status === "done"
            ? "border-primary bg-primary text-primary-foreground"
            : task.status === "wip"
              ? "border-amber-500 bg-amber-500/15 text-amber-600"
              : "border-muted-foreground/50",
        )}
      >
        {task.status === "done" ? <Check className="size-3" /> : null}
        {task.status === "wip" ? <span className="text-[10px]">~</span> : null}
      </button>
      <button
        type="button"
        data-feature-label={task.title}
        data-feature-help={t(
          "Edit this Markdown-backed task's title, details, status, and metadata",
        )}
        onClick={() => onEdit(task)}
        className="min-w-0 flex-1 text-left"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              "font-medium text-sm",
              task.status === "done" && "text-muted-foreground line-through",
            )}
          >
            {task.title}
          </span>
          <TaskBadges task={task} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
          <span>{task.projectName}</span>
          <ChevronRight className="size-3" />
          <span>{task.heading?.path.join(" / ") ?? t("Ungrouped")}</span>
          {task.details ? <span className="truncate">· {firstLine(task.details)}</span> : null}
        </div>
      </button>
      <button
        type="button"
        aria-label={`${t("Run agent for")} ${task.title}`}
        data-feature-help={t("Start an agent with this task's Markdown context as the prompt")}
        onClick={() => onRun(task)}
        className="rounded p-1.5 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100 focus:opacity-100"
      >
        <Bot className="size-4" />
      </button>
      <button
        type="button"
        aria-label={`${t("Edit")} ${task.title}`}
        data-feature-help={t(
          "Edit this Markdown-backed task's title, details, status, and metadata",
        )}
        onClick={() => onEdit(task)}
        className="rounded p-1.5 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100 focus:opacity-100"
      >
        <Pencil className="size-4" />
      </button>
    </article>
  ))
}

function alreadyInStatusLane(
  sourceStatus: TaskStatus,
  target: { kind: "status"; status: TaskStatus } | { kind: "heading"; headingKey: string },
): boolean {
  if (target.kind !== "status") return false
  if (target.status === "planned") return sourceStatus === "planned" || sourceStatus === "backlog"
  return sourceStatus === target.status
}

function StatusBoard({ tasks, draggedKey, onDrag, onDrop, onEdit }: BoardProps) {
  const t = useTranslate()
  return (
    <div className="p-4" data-testid="tasks-status-board">
      <AdaptiveBoardGrid>
        {KANBAN_LANES.map((lane) => (
          <BoardColumn
            key={lane.key}
            title={t(lane.title)}
            tasks={tasks.filter((task) => lane.statuses.includes(task.status))}
            draggedKey={draggedKey}
            onDrag={onDrag}
            onDrop={(event) => onDrop(event, { kind: "status", status: lane.destination })}
            onEdit={onEdit}
          />
        ))}
      </AdaptiveBoardGrid>
    </div>
  )
}

function AdaptiveBoardGrid({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="adaptive-board-grid"
      className="grid max-w-[92.25rem] justify-start gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),22.5rem))]"
    >
      {children}
    </div>
  )
}

function ColumnPicker({
  label,
  columns,
  visibleKeys,
  maxVisible,
  onToggle,
}: {
  label: string
  columns: Array<{ key: string; title: string; count: number }>
  visibleKeys: string[]
  maxVisible: number
  onToggle: (key: string) => void
}) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const hiddenTaskCount = columns
    .filter((column) => !visibleKeys.includes(column.key))
    .reduce((sum, column) => sum + column.count, 0)
  const hiddenColumnCount = columns.length - visibleKeys.length
  const hiddenTaskLabel =
    hiddenTaskCount === 0
      ? ""
      : `, ${hiddenTaskCount} ${t(hiddenTaskCount === 1 ? "task" : "tasks")} ${t("in hidden columns")}`
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={
          hiddenColumnCount > 0
            ? `${label.replace(t("Choose columns for"), t("Restore hidden columns for"))} (${hiddenColumnCount} ${t("hidden")}${hiddenTaskLabel})`
            : `${label} (${visibleKeys.length} ${t("of")} ${columns.length})`
        }
        aria-expanded={open}
        aria-haspopup="menu"
        data-feature-help={t("Choose which TODO Markdown headings appear as Kanban columns")}
        onClick={() => setOpen((current) => !current)}
        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
      >
        {hiddenColumnCount > 0 ? (
          <EyeOff className="size-3.5" />
        ) : (
          <Columns3 className="size-3.5" />
        )}
        {hiddenColumnCount > 0
          ? `${t("Hidden")} ${hiddenColumnCount}`
          : `${t("Columns")} ${visibleKeys.length}/${columns.length}`}
        {hiddenTaskCount > 0 ? (
          <span className="text-amber-600 dark:text-amber-400">
            · {hiddenTaskCount} {t("hidden")}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute top-full right-0 z-30 mt-1 max-h-72 w-64 overflow-auto rounded-md border border-border bg-popover p-1 shadow-lg"
        >
          {columns.map((column) => {
            const visible = visibleKeys.includes(column.key)
            const atLimit = !visible && visibleKeys.length >= maxVisible
            return (
              <button
                key={column.key}
                type="button"
                role="menuitemcheckbox"
                aria-checked={visible}
                aria-label={`${t(visible ? "Hide" : "Show")} ${column.title} ${t("column")} (${column.count} ${t(column.count === 1 ? "task" : "tasks")})`}
                disabled={atLimit}
                title={
                  atLimit ? `${t("Hide another column before showing")} ${column.title}` : undefined
                }
                onClick={() => onToggle(column.key)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                {visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                <span className="min-w-0 truncate">{column.title}</span>
                <span className="ml-auto shrink-0 text-muted-foreground">{column.count}</span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function toggleSelectedKey<T extends string>(selected: T[], key: T, limit: number): T[] {
  if (selected.includes(key)) return selected.filter((candidate) => candidate !== key)
  if (selected.length >= limit) return selected
  return [...selected, key]
}

function headingVisibleKeys(
  projectId: string,
  columns: Array<{ visibilityKey: string }>,
  selections: Record<string, string[]>,
): string[] {
  const available = new Set(columns.map((column) => column.visibilityKey))
  const selected = selections[projectId]
  if (selected) return selected.filter((key) => available.has(key))
  return columns.slice(0, 4).map((column) => column.visibilityKey)
}

function HeadingBoard({
  tasks,
  sources,
  selections,
  onSelectionChange,
  draggedKey,
  onDrag,
  onDrop,
  onEdit,
}: BoardProps & {
  sources: TaskSource[]
  selections: Record<string, string[]>
  onSelectionChange: (projectId: string, keys: string[]) => void
}) {
  const t = useTranslate()
  return (
    <div className="flex flex-col gap-5 p-4" data-testid="tasks-heading-board">
      {sources
        .filter((source) => source.state === "ready")
        .map((source) => {
          const projectTasks = tasks.filter((task) => task.projectId === source.projectId)
          const taskGroups = groupBy(projectTasks, (task) => task.boardHeadingKey ?? "ungrouped")
          const titleOccurrences = new Map<string, number>()
          const columns = source.boardHeadings.map((heading) => {
            const title = heading.path.join(" / ")
            const occurrence = titleOccurrences.get(title) ?? 0
            titleOccurrences.set(title, occurrence + 1)
            return {
              key: heading.key,
              visibilityKey: `${title}\u0000${occurrence}`,
              title,
              tasks: taskGroups.get(heading.key) ?? [],
            }
          })
          const ungrouped = taskGroups.get("ungrouped")
          if (ungrouped?.length) {
            columns.push({
              key: "ungrouped",
              visibilityKey: "ungrouped",
              title: t("Ungrouped"),
              tasks: ungrouped,
            })
          }
          const visibleKeys = headingVisibleKeys(source.projectId, columns, selections)
          return (
            <section key={source.projectId} data-testid="tasks-heading-project">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="min-w-0 truncate font-medium text-muted-foreground text-xs uppercase tracking-wide">
                  {source.projectName}
                </h2>
                <ColumnPicker
                  label={`${t("Choose columns for")} ${source.projectName}`}
                  columns={columns.map((column) => ({
                    key: column.visibilityKey,
                    title: column.title,
                    count: column.tasks.length,
                  }))}
                  visibleKeys={visibleKeys}
                  maxVisible={4}
                  onToggle={(key) =>
                    onSelectionChange(source.projectId, toggleSelectedKey(visibleKeys, key, 4))
                  }
                />
              </div>
              <AdaptiveBoardGrid>
                {columns
                  .filter((column) => visibleKeys.includes(column.visibilityKey))
                  .map((column) => (
                    <BoardColumn
                      key={column.key}
                      title={column.title}
                      tasks={column.tasks}
                      draggedKey={draggedKey}
                      onDrag={onDrag}
                      onHide={() =>
                        onSelectionChange(
                          source.projectId,
                          visibleKeys.filter((key) => key !== column.visibilityKey),
                        )
                      }
                      onDrop={(event) => {
                        const draggedTask = draggedKey
                          ? tasks.find((task) => task.key === draggedKey)
                          : null
                        if (
                          column.key !== "ungrouped" &&
                          draggedTask?.projectId === source.projectId
                        ) {
                          onDrop(event, { kind: "heading", headingKey: column.key })
                        }
                      }}
                      onEdit={onEdit}
                    />
                  ))}
              </AdaptiveBoardGrid>
              {visibleKeys.length === 0 ? (
                <p className="py-8 text-center text-muted-foreground text-xs">
                  {t("No Heading columns selected. Use Columns to show one.")}
                </p>
              ) : null}
            </section>
          )
        })}
    </div>
  )
}

interface BoardProps {
  tasks: TaskRecord[]
  draggedKey: string | null
  onDrag: (key: string | null) => void
  onDrop: (
    event: DragEvent,
    target: { kind: "status"; status: TaskStatus } | { kind: "heading"; headingKey: string },
  ) => void
  onEdit: (task: TaskRecord) => void
}

function BoardColumn({
  title,
  tasks,
  draggedKey,
  onDrag,
  onHide,
  onDrop,
  onEdit,
}: {
  title: string
  tasks: TaskRecord[]
  draggedKey: string | null
  onDrag: (key: string | null) => void
  onHide?: () => void
  onDrop: (event: DragEvent) => void
  onEdit: (task: TaskRecord) => void
}) {
  const t = useTranslate()
  return (
    <fieldset
      aria-label={title}
      data-testid="board-column"
      className="min-h-40 min-w-0 rounded-lg border border-border bg-muted/20"
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <header className="flex min-w-0 items-center gap-2 border-border border-b px-3 py-2">
        <h3 className="min-w-0 flex-1 truncate font-medium text-xs" title={title}>
          {title}
        </h3>
        <span className="shrink-0 text-muted-foreground text-xs">{tasks.length}</span>
        {onHide ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 text-muted-foreground"
            aria-label={`${t("Hide")} ${title} ${t("column")}`}
            data-feature-help={t("Hide this heading column without changing the TODO Markdown")}
            onClick={onHide}
          >
            <Eye className="size-3.5" />
          </Button>
        ) : null}
      </header>
      <div className="flex flex-col gap-2 p-2">
        {tasks.map((task) => (
          <button
            key={task.key}
            type="button"
            draggable
            data-testid="task-card"
            data-dragging={draggedKey === task.key}
            data-feature-label={task.title}
            data-feature-help={t(
              "Edit this Markdown-backed task or drag it to update the TODO Markdown",
            )}
            onDragStart={() => onDrag(task.key)}
            onDragEnd={() => onDrag(null)}
            onClick={() => onEdit(task)}
            className="min-w-0 rounded-md border border-border bg-background p-3 text-left shadow-sm data-[dragging=true]:opacity-50"
          >
            <span className="block break-words font-medium text-sm">{task.title}</span>
            <span className="mt-2 flex flex-wrap gap-1">
              <TaskBadges task={task} />
            </span>
            <span className="mt-2 block text-muted-foreground text-xs">{task.projectName}</span>
          </button>
        ))}
      </div>
    </fieldset>
  )
}

function TaskBadges({ task }: { task: TaskRecord }) {
  const t = useTranslate()
  return (
    <>
      <Badge>{t(STATUS_LABEL[task.status])}</Badge>
      {task.priority ? <Badge>{t(task.priority)}</Badge> : null}
      {task.owner ? <Badge>@{task.owner}</Badge> : null}
      {task.labels.map((value) => (
        <Badge key={value}>#{value}</Badge>
      ))}
    </>
  )
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-[10px]">
      {children}
    </span>
  )
}

function SourceNotices({ sources }: { sources: TaskSource[] }) {
  const t = useTranslate()
  const notices = sources.filter(
    (source) => source.state === "ambiguous" || source.state === "error",
  )
  if (notices.length === 0) return null
  return (
    <div className="border-amber-500/30 border-b bg-amber-500/10 px-4 py-2 text-amber-700 text-xs dark:text-amber-300">
      {notices.map((source) => (
        <p key={source.projectId}>
          <strong>{source.projectName}:</strong>{" "}
          {source.state === "ambiguous"
            ? `${t("multiple TODO Markdown files found")} (${source.candidates.join(", ")}); ${t("resolve the duplicate before editing tasks in PI Lab.")}`
            : (source.error ?? t("TODO Markdown could not be read."))}
        </p>
      ))}
    </div>
  )
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="border-destructive/30 border-b bg-destructive/10 px-4 py-2 text-destructive text-xs">
      {message}
    </div>
  )
}

function TaskEditorDialog({
  task,
  sources,
  initialProjectId,
  busy,
  onClose,
  onSave,
  onDelete,
}: {
  task?: TaskRecord
  sources: TaskSource[]
  initialProjectId?: string
  busy: boolean
  onClose: () => void
  onSave: (projectId: string, relPath: string, draft: TaskDraft) => Promise<void>
  onDelete?: () => Promise<void>
}) {
  const t = useTranslate()
  const initialSource =
    sources.find((source) => source.projectId === (task?.projectId ?? initialProjectId)) ??
    sources[0]
  const [projectId, setProjectId] = useState(task?.projectId ?? initialSource?.projectId ?? "")
  const source = sources.find((candidate) => candidate.projectId === projectId)
  const sourceChoices =
    source?.state === "ambiguous"
      ? source.candidates
      : [task?.relPath ?? source?.relPath ?? "TODO.md"].filter(isString)
  const [relPath, setRelPath] = useState(task?.relPath ?? sourceChoices[0] ?? "TODO.md")
  const [title, setTitle] = useState(task?.title ?? "")
  const [details, setDetails] = useState(task?.details ?? "")
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? "planned")
  const [priority, setPriority] = useState(task?.priority ?? "")
  const [labels, setLabels] = useState(task?.labels.join(", ") ?? "")
  const [owner, setOwner] = useState(task?.owner ?? "")

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!title.trim() || !projectId || !relPath) return
    await onSave(projectId, relPath, {
      title: title.trim(),
      details: details.trim(),
      status,
      priority: priority.trim() || null,
      labels: labels
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      owner: owner.trim() || null,
    })
  }

  return (
    <Modal title={t(task ? "Edit task" : "New task")} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {!task ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("Project")}>
              <select
                aria-label={t("Project")}
                value={projectId}
                onChange={(event) => {
                  const next = event.target.value
                  setProjectId(next)
                  const nextSource = sources.find((candidate) => candidate.projectId === next)
                  setRelPath(nextSource?.relPath ?? nextSource?.candidates[0] ?? "TODO.md")
                }}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              >
                {sources.map((candidate) => (
                  <option key={candidate.projectId} value={candidate.projectId}>
                    {candidate.projectName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("TODO file")}>
              <select
                aria-label={t("TODO file")}
                value={relPath}
                onChange={(event) => setRelPath(event.target.value)}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              >
                {sourceChoices.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {candidate}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ) : null}
        <Field label={t("Title")}>
          <Input
            aria-label={t("Title")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
        </Field>
        <Field label={t("Details")}>
          <textarea
            aria-label={t("Details")}
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            rows={7}
            placeholder={t("Optional Markdown detail block")}
            className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("Stage")}>
            <select
              aria-label={t("Stage")}
              value={status}
              onChange={(event) => setStatus(event.target.value as TaskStatus)}
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
            >
              {STATUS_ORDER.map((value) => (
                <option key={value} value={value}>
                  {t(STATUS_LABEL[value])}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("Priority")}>
            <select
              aria-label={t("Priority")}
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
            >
              <option value="">{t("None")}</option>
              <option value="low">{t("Low")}</option>
              <option value="medium">{t("Medium")}</option>
              <option value="high">{t("High")}</option>
            </select>
          </Field>
          <Field label={t("Labels")}>
            <Input
              aria-label={t("Labels")}
              value={labels}
              onChange={(event) => setLabels(event.target.value)}
              placeholder="ui, parser"
            />
          </Field>
          <Field label={t("Owner")}>
            <Input
              aria-label={t("Owner")}
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              placeholder={t("Optional")}
            />
          </Field>
        </div>
        <div className="flex items-center justify-between pt-1">
          <div>
            {onDelete ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="gap-1.5 text-destructive"
                disabled={busy}
                onClick={() => void onDelete()}
              >
                <Trash2 className="size-4" />
                {t("Delete")}
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              {t("Cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={busy || !title.trim()}>
              {t("Save")}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  )
}

function RunTaskDialog({
  task,
  agents,
  defaultAgentId,
  busy,
  onClose,
  onRun,
}: {
  task: TaskRecord
  agents: AgentChoice[]
  defaultAgentId: string
  busy: boolean
  onClose: () => void
  onRun: (agentId: string, prompt: string) => Promise<void>
}) {
  const t = useTranslate()
  const [agentId, setAgentId] = useState(
    agents.some((agent) => agent.id === defaultAgentId) ? defaultAgentId : (agents[0]?.id ?? ""),
  )
  const [prompt, setPrompt] = useState(() => taskPrompt(task))
  return (
    <Modal title={t("Run agent from task")} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Field label={t("Agent")}>
          <select
            aria-label={t("Agent")}
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("Prompt")}>
          <textarea
            aria-label={t("Prompt")}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={10}
            className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none"
          />
        </Field>
        <p className="text-muted-foreground text-xs">
          {t("Model and reasoning-effort controls are intentionally deferred.")}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            size="sm"
            disabled={busy || !agentId || !prompt.trim()}
            onClick={() => void onRun(agentId, prompt.trim())}
          >
            {t("Run agent")}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const t = useTranslate()
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
      >
        <header className="flex items-center justify-between border-border border-b px-4 py-3">
          <h2 className="font-semibold text-sm">{title}</h2>
          <button
            type="button"
            aria-label={t("Close")}
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="overflow-y-auto p-4">{children}</div>
      </section>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="font-medium text-xs">{label}</span>
      {children}
    </div>
  )
}

function FilterSelect({
  label,
  description,
  value,
  values,
  render = (item) => item,
  onChange,
}: {
  label: string
  description: string
  value: string
  values: readonly string[]
  render?: (value: string) => string
  onChange: (value: string) => void
}) {
  if (values.length === 0) return null
  return (
    <select
      aria-label={label}
      title={description}
      data-feature-label={label}
      data-feature-help={description}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 rounded-md border border-border bg-background px-2 text-xs"
    >
      <option value="">{label}</option>
      {values.map((item) => (
        <option key={item} value={item}>
          {render(item)}
        </option>
      ))}
    </select>
  )
}

function ViewButton({
  active,
  label,
  description,
  onClick,
  children,
}: {
  active: boolean
  label: string
  description: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={description}
      aria-label={label}
      data-feature-label={label}
      data-feature-help={description}
      aria-pressed={active}
      data-active={active}
      onClick={onClick}
      className="grid size-7 place-items-center rounded text-muted-foreground data-[active=true]:bg-background data-[active=true]:text-foreground data-[active=true]:shadow-sm [&_svg]:size-3.5"
    >
      {children}
    </button>
  )
}

function taskToDraft(task: TaskRecord): TaskDraft {
  return {
    title: task.title,
    details: task.details,
    status: task.status,
    priority: task.priority,
    labels: task.labels,
    owner: task.owner,
  }
}

function taskPrompt(task: TaskRecord): string {
  const details = task.details ? `\n\nDetails:\n${task.details}` : ""
  return `Work on this task in ${task.projectName}:\n\n${task.title}${details}\n\nThe source of truth is ${task.relPath}. Keep that task's status current as work progresses.`
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? ""
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b))
}

function isString(value: string | null): value is string {
  return value !== null
}

function groupBy<T>(items: T[], keyFor: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = keyFor(item)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  return groups
}
