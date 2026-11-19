import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import {
  LayoutDashboard,
  type LucideIcon,
  Monitor,
  MonitorCog,
  MonitorPlay,
  MonitorUp,
  MonitorX,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { usePopupDismiss } from "../components/usePopupDismiss"
import { useInterfaceLanguage, useTranslate } from "../i18n/language"
import { useMachineFilter } from "../preferences/preferences"
import { rememberSettingsReturnRoute } from "../routes/_shell/-settingsReturnRoute"
import { desktopIpc } from "../trpc/client"
import { CONNECTION_LABELS } from "./MachineControls"
import {
  DEVICE_SETTINGS_QUERY_KEY,
  forgetCachedProjects,
  MACHINES_QUERY_KEY,
  type MachineSummary,
  useDeviceMachineSettings,
  useMachineState,
} from "./machines"

/**
 * The Machines group's actions for one machine: a left click shows its
 * projects on the Projects Dashboard ({@link useShowMachineProjects}); a right
 * click opens {@link MachineMenu}.
 */

/** Open the Projects Dashboard filtered to one machine's projects (the Dashboard's machine filter). */
export function useShowMachineProjects(): (machineId: string) => void {
  const navigate = useNavigate()
  const [, setMachineFilter] = useMachineFilter()
  return (machineId) => {
    setMachineFilter(machineId)
    void navigate({ to: "/" })
  }
}

const LOCAL_SERVER_LABELS = {
  always: "Always",
  "while-open": "Only while PI Lab is open",
  off: "Off (client only)",
} as const

type MenuView = "menu" | "card" | "remove"

/**
 * The right-click menu of a machine in the Machines group, at the pointer:
 * Machine settings, Show its projects, Reconnect, Update (only when the
 * machine is behind this app), Machine card and Remove machine (asks first).
 * Reconnect and Update errors, and a token Remove could not revoke, go to
 * `onError` (the sidebar's error line): the menu is closed by then.
 */
export function MachineMenu({
  machine,
  projectCount,
  position,
  onClose,
  onError,
}: {
  machine: MachineSummary
  projectCount: number
  position: { x: number; y: number }
  onClose: () => void
  onError: (message: string | null) => void
}) {
  const t = useTranslate()
  const navigate = useNavigate()
  const { location } = useRouterState()
  const queryClient = useQueryClient()
  const showProjects = useShowMachineProjects()
  const [view, setView] = useState<MenuView>("menu")
  const rootRef = useRef<HTMLDivElement | null>(null)
  usePopupDismiss(view !== "remove", [rootRef], onClose)
  const { machineId } = machine
  const refreshMachines = () => void queryClient.invalidateQueries({ queryKey: MACHINES_QUERY_KEY })
  const reconnect = useMutation({
    mutationFn: () => desktopIpc().desktop.machines.reconnect.mutate({ machineId }),
    onMutate: () => onError(null),
    onError: (error) => onError(`${t("Reconnect")}: ${error.message}`),
    onSettled: refreshMachines,
  })
  const update = useMutation({
    mutationFn: () => desktopIpc().desktop.machines.update.mutate({ machineId }),
    onMutate: () => onError(null),
    onError: (error) => onError(`${t("Update")}: ${error.message}`),
    onSettled: refreshMachines,
  })

  const items: { id: string; label: string; Icon: LucideIcon; run: () => void }[] = [
    {
      id: "settings",
      label: t("Machine settings"),
      Icon: MonitorCog,
      run: () => {
        rememberSettingsReturnRoute(location)
        void navigate({ to: "/settings", search: { section: "machines" } })
        onClose()
      },
    },
    {
      id: "projects",
      label: t("Show its projects"),
      Icon: LayoutDashboard,
      run: () => {
        showProjects(machineId)
        onClose()
      },
    },
    {
      id: "reconnect",
      label: t("Reconnect"),
      Icon: MonitorPlay,
      run: () => {
        reconnect.mutate()
        onClose()
      },
    },
    ...(machine.updateAvailable
      ? [
          {
            id: "update",
            label: t("Update"),
            Icon: MonitorUp,
            run: () => {
              update.mutate()
              onClose()
            },
          },
        ]
      : []),
    { id: "card", label: t("Machine card"), Icon: Monitor, run: () => setView("card") },
    { id: "remove", label: t("Remove machine"), Icon: MonitorX, run: () => setView("remove") },
  ]

  if (view === "remove") {
    return <RemoveMachineDialog machine={machine} onClose={onClose} onError={onError} />
  }
  return (
    <div
      ref={rootRef}
      className="fixed z-50"
      style={{ left: position.x, top: position.y }}
      data-machine-id={machineId}
    >
      {view === "card" ? (
        <MachineCard machine={machine} projectCount={projectCount} />
      ) : (
        <div
          data-testid="machine-menu"
          role="menu"
          className="w-56 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl"
        >
          {items.map(({ id, label, Icon, run }) => (
            <button
              key={id}
              type="button"
              role="menuitem"
              data-testid={`machine-menu-${id}`}
              onClick={run}
              className={
                id === "remove"
                  ? "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-destructive text-sm transition-colors hover:bg-destructive/10"
                  : "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-accent/60"
              }
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">{label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * A summary of one machine: name, ssh host and the address ssh connects to,
 * connection state, server version, date added, its number of projects and
 * this Mac's "Local server" setting.
 */
function MachineCard({ machine, projectCount }: { machine: MachineSummary; projectCount: number }) {
  const t = useTranslate()
  const [language] = useInterfaceLanguage()
  const state = useMachineState(machine.machineId)
  const settings = useDeviceMachineSettings()
  const address = useQuery({
    queryKey: ["desktop", "machines", "address", machine.machineId],
    queryFn: () => desktopIpc().desktop.machines.address.query({ machineId: machine.machineId }),
  })
  const rows: { id: string; label: string; value: string }[] = [
    { id: "ssh-host", label: t("SSH host"), value: machine.sshHost },
    {
      id: "address",
      label: t("Address"),
      value: address.isError
        ? address.error.message
        : address.data === undefined
          ? "…"
          : (address.data ?? t("Unknown")),
    },
    { id: "state", label: t("Connection"), value: t(CONNECTION_LABELS[state]) },
    { id: "version", label: t("Server version"), value: machine.version ?? t("Unknown") },
    {
      id: "added",
      label: t("Added"),
      value: new Date(machine.addedAt).toLocaleDateString(language, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
    },
    { id: "projects", label: t("Projects"), value: String(projectCount) },
    {
      id: "local-server",
      label: t("Local server"),
      value: settings === null ? "…" : t(LOCAL_SERVER_LABELS[settings.localServer]),
    },
  ]
  return (
    <section
      data-testid="machine-card"
      aria-label={t("Machine card")}
      className="w-72 rounded-xl border border-border bg-card p-3 text-card-foreground shadow-xl"
    >
      <h2
        data-testid="machine-card-name"
        className="truncate font-medium text-foreground text-sm"
        title={machine.name}
      >
        {machine.name}
      </h2>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {rows.map((row) => (
          <div key={row.id} className="contents">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd
              data-testid={`machine-card-${row.id}`}
              className="min-w-0 cursor-text select-text truncate text-foreground"
              title={row.value}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/** Asks before removing a machine; Remove has the effect of Remove in Settings > Machines. */
function RemoveMachineDialog({
  machine,
  onClose,
  onError,
}: {
  machine: MachineSummary
  onClose: () => void
  onError: (message: string | null) => void
}) {
  const t = useTranslate()
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: () => desktopIpc().desktop.machines.remove.mutate({ machineId: machine.machineId }),
    onSuccess: (result) => {
      onError(
        result.revoked
          ? null
          : `${machine.name}: ${t("could not be reached, so its token is still valid there. Revoke it in Settings > Machines on that machine.")}`,
      )
      forgetCachedProjects(machine.machineId)
      void queryClient.invalidateQueries({ queryKey: MACHINES_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: DEVICE_SETTINGS_QUERY_KEY })
      onClose()
    },
  })
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is a click-to-dismiss surface; Escape and the Cancel button provide keyboard-accessible dismissal.
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismissal mirrors Escape, which is already handled by the dialog.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="machine-remove-title"
        data-testid="machine-remove-dialog"
        className="w-full max-w-sm rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xl"
      >
        <h2 id="machine-remove-title" className="font-medium text-foreground text-sm">
          {t("Remove machine?")}
        </h2>
        <p className="mt-2 cursor-text select-text break-all text-foreground text-sm">
          {machine.name}
        </p>
        <p className="mt-2 text-muted-foreground text-xs">
          {t(
            "PI Lab forgets this machine and revokes its token there when it can be reached. The projects and files on the machine stay.",
          )}
        </p>
        {remove.error ? (
          <p role="alert" className="mt-2 text-destructive text-xs">
            {remove.error.message}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            data-testid="machine-remove-cancel"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            {t("Cancel")}
          </button>
          <button
            type="button"
            data-testid="machine-remove-confirm"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
            className="rounded-md bg-destructive px-3 py-1.5 text-destructive-foreground text-sm transition-colors hover:bg-destructive/90 disabled:opacity-60"
          >
            {t("Remove")}
          </button>
        </div>
      </div>
    </div>
  )
}
