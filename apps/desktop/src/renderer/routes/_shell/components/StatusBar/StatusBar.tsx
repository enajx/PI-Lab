import { cn } from "@pi-lab/ui"
import { useQuery } from "@tanstack/react-query"
import { Bot, Coffee, FileText, FolderGit2, GitBranch, Server } from "lucide-react"
import { type ReactNode, useRef, useState } from "react"
import { useCaffeine } from "../../../../caffeine"
import { usePopupDismiss } from "../../../../components/usePopupDismiss"
import { useTranslate } from "../../../../i18n/language"
import { formatBinding, getBinding } from "../../../../shortcuts/shortcuts"
import { useTRPC } from "../../../../trpc/react"
import { useAgentStatus } from "../../-ProjectActivity"
import { readSshConfigPathOverride } from "../../utils/sshConfigPathOverride"
import { useLatestLatexBuild } from "./latexBuildStore"
import { useViewProject } from "./viewProjectStore"

/** Same refresh rate as the project view's Code changes panel. */
const GIT_STATE_REFETCH_MS = 8_000

const CHANNEL_NAMES = { alpha: "Alpha", beta: "Beta", stable: "Stable" } as const

/** One small item of the bar: an icon and its text; `title` and `help` fill the "What's this?" box. */
function Item({
  testId,
  icon,
  title,
  help,
  className,
  children,
}: {
  testId: string
  icon: ReactNode
  title: string
  help: string
  className: string
  children: ReactNode
}) {
  return (
    <span
      data-testid={testId}
      title={title}
      data-feature-label={title}
      data-feature-help={help}
      className={cn("inline-flex min-w-0 items-center gap-1 truncate", className)}
    >
      {icon}
      <span className="truncate">{children}</span>
    </span>
  )
}

/**
 * The window status bar: one small-font row at the bottom of the window,
 * shown when it is turned on in Settings or the command palette. It reads the
 * data the app already has: the project the current view has selected (the
 * project view or a science tab's picker, see `viewProjectStore`; `projects.get`) and its Git
 * branch and dirty state (`projects.gitState`), the live agent sessions (the
 * shell's shared subscription), caffeine (`useCaffeine`), the last LaTeX build
 * of a mounted editor, the channel and version, the command palette shortcut,
 * and the hosts of `~/.ssh/config` in a popover.
 */
export function StatusBar() {
  const t = useTranslate()
  const projectId = useViewProject()
  return (
    <footer
      data-testid="window-status-bar"
      className="flex h-6 shrink-0 select-none items-center gap-4 bg-sidebar px-3 text-[11px] text-muted-foreground"
    >
      {projectId ? <ProjectItems projectId={projectId} /> : null}
      <AgentsItem />
      <CaffeineItem />
      <LatexItem />
      <span className="ms-auto" />
      <HostsItem />
      <VersionItem />
      <Item
        testId="status-bar-palette-hint"
        icon={null}
        title={t("Command palette")}
        help={t("Press this shortcut to search PI Lab's commands and projects.")}
        className="shrink-0"
      >
        {`${formatBinding(getBinding("command-palette"))} ${t("Commands")}`}
      </Item>
    </footer>
  )
}

/** The open project's name, and its Git branch with `*` when the working tree has changes. */
function ProjectItems({ projectId }: { projectId: string }) {
  const t = useTranslate()
  const trpc = useTRPC()
  const project = useQuery(trpc.projects.get.queryOptions({ id: projectId }))
  const git = useQuery(
    trpc.projects.gitState.queryOptions(
      { id: projectId },
      { refetchInterval: GIT_STATE_REFETCH_MS },
    ),
  )
  return (
    <>
      <Item
        testId="status-bar-project"
        icon={<FolderGit2 className="size-3 shrink-0" aria-hidden />}
        title={t("Current project")}
        help={t("The project this view shows.")}
        className=""
      >
        {project.data?.name ?? ""}
      </Item>
      {git.isError ? (
        <span role="alert" className="truncate text-destructive">
          {t("Could not read Git:")} {git.error.message}
        </span>
      ) : git.data ? (
        <span
          data-testid="status-bar-branch"
          data-dirty={git.data.dirty}
          title={t("Git branch")}
          data-feature-label={t("Git branch")}
          data-feature-help={
            git.data.dirty
              ? t("The project's checked-out branch. * means it has uncommitted changes.")
              : t("The project's checked-out branch. It has no uncommitted changes.")
          }
          className="inline-flex min-w-0 items-center gap-1"
        >
          <GitBranch className="size-3 shrink-0" aria-hidden />
          <span className="truncate">
            {`${git.data.branch ?? t("detached HEAD")}${git.data.dirty ? "*" : ""}`}
          </span>
        </span>
      ) : null}
    </>
  )
}

/** How many agent sessions are running, and how many wait for input. */
function AgentsItem() {
  const t = useTranslate()
  const sessions = useAgentStatus()
  if (sessions.error) {
    return (
      <span role="alert" className="truncate text-destructive">
        {t("Could not check sessions:")} {sessions.error.message}
      </span>
    )
  }
  // The live list holds only running sessions (working or waiting).
  const running = sessions.data ?? []
  const waiting = running.filter((session) => session.state === "waiting").length
  return (
    <Item
      testId="status-bar-agents"
      icon={<Bot className="size-3 shrink-0" aria-hidden />}
      title={t("Running agents")}
      help={t("Agent sessions running now, and how many wait for your input.")}
      className={waiting > 0 ? "text-amber-600 dark:text-amber-400" : ""}
    >
      {`${running.length} ${running.length === 1 ? t("agent") : t("agents")}`}
      {waiting > 0 ? ` · ${waiting} ${t("need attention")}` : ""}
    </Item>
  )
}

function CaffeineItem() {
  const t = useTranslate()
  const { status } = useCaffeine()
  return (
    <Item
      testId="status-bar-caffeine"
      icon={<Coffee className="size-3 shrink-0" aria-hidden />}
      title={t("Caffeine")}
      help={t(
        "Prevent the computer from sleeping. Change it with the coffee button in the top bar.",
      )}
      className="shrink-0"
    >
      {`${t("Caffeine")} ${t(status.mode)}`}
    </Item>
  )
}

/** The last LaTeX build of a mounted editor; nothing before one has run. */
function LatexItem() {
  const t = useTranslate()
  const build = useLatestLatexBuild()
  if (build === null) return null
  return (
    <Item
      testId="status-bar-latex"
      icon={<FileText className="size-3 shrink-0" aria-hidden />}
      title={t("LaTeX build")}
      help={t("The state of the last LaTeX build in an open editor.")}
      className={build.state === "failed" ? "text-destructive" : ""}
    >
      {t(build.message)}
    </Item>
  )
}

/** The app channel and version, e.g. "Beta 0.1.0"; Alpha shows its build commit, e.g. "Alpha 59ed026e". */
function VersionItem() {
  const t = useTranslate()
  const trpc = useTRPC()
  const info = useQuery(trpc.system.appInfo.queryOptions())
  if (info.error) {
    return (
      <span role="alert" className="truncate text-destructive">
        {t("Could not read the version:")} {info.error.message}
      </span>
    )
  }
  if (!info.data) return null
  return (
    <Item
      testId="status-bar-version"
      icon={null}
      title={t("Channel and version")}
      help={t(
        "The PI Lab release channel and version you are running. Alpha builds show their git commit.",
      )}
      className="shrink-0"
    >
      {`${CHANNEL_NAMES[info.data.channel]} ${info.data.commit ?? info.data.version}`}
    </Item>
  )
}

/** `N hosts` from `~/.ssh/config`; a click lists them (no Connect action yet). */
function HostsItem() {
  const t = useTranslate()
  const trpc = useTRPC()
  const [open, setOpen] = useState(false)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const hosts = useQuery(
    trpc.science.cluster.sshHosts.queryOptions({ path: readSshConfigPathOverride() }),
  )
  usePopupDismiss(open, [hostRef], () => setOpen(false))
  if (hosts.isError) {
    return (
      <span role="alert" className="truncate text-destructive">
        {t("Could not read the SSH config:")} {hosts.error.message}
      </span>
    )
  }
  const list = hosts.data ?? []
  return (
    <div ref={hostRef} className="relative flex shrink-0 items-center">
      <button
        type="button"
        data-testid="status-bar-hosts"
        aria-expanded={open}
        title={t("SSH hosts")}
        data-feature-label={t("SSH hosts")}
        data-feature-help={t("The hosts in ~/.ssh/config. Click to list them.")}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex items-center gap-1 rounded px-1 hover:bg-muted hover:text-foreground"
      >
        <Server className="size-3 shrink-0" aria-hidden />
        {`${list.length} ${list.length === 1 ? t("host") : t("hosts")}`}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t("SSH hosts")}
          data-testid="status-bar-hosts-popover"
          className="absolute right-0 bottom-7 z-50 w-72 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-xl"
        >
          <h2 className="font-semibold text-sm">{t("SSH hosts")}</h2>
          {list.length === 0 ? (
            <p className="mt-2 text-muted-foreground text-xs">{t("No hosts in ~/.ssh/config.")}</p>
          ) : (
            <ul className="mt-2 max-h-60 space-y-1.5 overflow-y-auto">
              {list.map((host) => (
                <li
                  key={host.alias}
                  data-testid="status-bar-host"
                  className="flex items-baseline justify-between gap-2 text-xs"
                >
                  <span className="truncate font-medium">{host.alias}</span>
                  <span className="truncate text-muted-foreground">
                    {`${host.user ? `${host.user}@` : ""}${host.hostname ?? ""}${host.port ? `:${host.port}` : ""}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
