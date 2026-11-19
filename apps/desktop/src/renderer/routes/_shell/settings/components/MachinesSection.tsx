import { Button, cn } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { useState } from "react"
import type { InstallProgress } from "../../../../../main/machines/machineConnections"
import type { LocalServerMode } from "../../../../../main/machines/machineStore"
import { SERVER_UPDATE_CAPABILITY } from "../../../../../shared/clientApi"
import { useTranslate } from "../../../../i18n/language"
import { localServerOff } from "../../../../machines/localServer"
import { CONNECTION_DOTS, CONNECTION_LABELS } from "../../../../machines/MachineControls"
import {
  DEVICE_SETTINGS_QUERY_KEY,
  forgetCachedProjects,
  MACHINES_QUERY_KEY,
  MACHINES_REFRESH_MS,
  MachineScope,
  type MachineSummary,
  showMachineUi,
  useDeviceMachineSettings,
  useMachineState,
  useMachines,
} from "../../../../machines/machines"
import { desktopIpc } from "../../../../trpc/client"
import { useTRPC } from "../../../../trpc/react"
import { useServerCapability } from "../../../../trpc/serverCapabilities"
import { SelectField, SettingsSection, TextField, ToggleField } from "./SettingsControls"

/** How often the Add machine form reads the step of the running add. */
const ADD_PROGRESS_REFRESH_MS = 300

/**
 * Settings > Machines: the remote machines this app connects to (add over
 * SSH, remove), and the devices allowed on this Mac's own server (revoke).
 */
export function MachinesSection() {
  const t = useTranslate()
  const machines = useMachines(MACHINES_REFRESH_MS)
  const settings = useDeviceMachineSettings()
  const [notice, setNotice] = useState<string | null>(null)
  // While multi-machine is off the section shows only the toggle and Local server.
  const multiMachine = settings?.multiMachine === true
  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        testId="settings-section-machines"
        title="Machines"
        description="Other computers whose PI Lab server this app connects to over SSH."
      >
        {settings === null || machines === null ? null : (
          <MultiMachineField on={multiMachine} locked={machines.length > 0} />
        )}
        {machines === null || !multiMachine ? null : machines.length === 0 ? (
          <p
            data-testid="settings-machines-empty"
            className="px-4 py-3 text-muted-foreground text-sm"
          >
            {t("No machines yet.")}
          </p>
        ) : (
          machines.map((machine) => (
            <MachineRow
              key={machine.machineId}
              machine={machine}
              onRemoved={(revoked) =>
                setNotice(
                  revoked
                    ? null
                    : `${machine.name}: ${t("could not be reached, so its token is still valid there. Revoke it in Settings > Machines on that machine.")}`,
                )
              }
            />
          ))
        )}
        {notice ? (
          <p
            role="alert"
            data-testid="settings-machine-notice"
            className="px-4 py-3 text-amber-600 text-xs dark:text-amber-400"
          >
            {notice}
          </p>
        ) : null}
        <LocalServerFields machines={machines ?? []} />
        {multiMachine ? (
          <>
            <BehindPolicyField />
            <AddMachineForm />
          </>
        ) : null}
      </SettingsSection>
      {localServerOff() || !multiMachine ? null : <ThisMacDevices />}
    </div>
  )
}

/**
 * The multi-machine toggle. Adding a machine turns it on, and it stays on
 * (locked) while any machine is added; Electron main refuses Off then too.
 */
function MultiMachineField({ on, locked }: { on: boolean; locked: boolean }) {
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (next: boolean) =>
      desktopIpc().desktop.machines.setMultiMachine.mutate({ on: next }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: DEVICE_SETTINGS_QUERY_KEY }),
  })
  return (
    <>
      <ToggleField
        testId="settings-multi-machine"
        label="Multi-machine"
        description={
          locked
            ? "On while a machine is added. Remove all machines to turn it off."
            : "Run persistent projects on remote machines over SSH"
        }
        checked={on || locked}
        disabled={locked || save.isPending}
        onChange={(next) => save.mutate(next)}
      />
      {save.error ? (
        <p role="alert" className="px-4 py-3 text-destructive text-xs">
          {save.error.message}
        </p>
      ) : null}
    </>
  )
}

/**
 * "Local server" (this Mac's own server) and, once a machine is added, the
 * default machine New project is preset to. With the local server off the
 * default cannot be this Mac (Electron main refuses it).
 */
function LocalServerFields({ machines }: { machines: MachineSummary[] }) {
  const queryClient = useQueryClient()
  const settings = useDeviceMachineSettings()
  const onSettled = () =>
    void queryClient.invalidateQueries({ queryKey: DEVICE_SETTINGS_QUERY_KEY })
  const saveMode = useMutation({
    mutationFn: (mode: LocalServerMode) =>
      desktopIpc().desktop.machines.setLocalServer.mutate({ mode }),
    onSettled,
  })
  const saveDefault = useMutation({
    mutationFn: (machineId: string | null) =>
      desktopIpc().desktop.machines.setDefaultMachine.mutate({ machineId }),
    onSettled,
  })
  if (settings === null) return null
  return (
    <>
      <SelectField
        testId="settings-local-server"
        label="Local server"
        description="This Mac's own PI Lab server. Always keeps it running after you quit; Only while PI Lab is open stops it when you quit; Off uses only the added machines. Off, and back from Off, apply the next time PI Lab starts."
        value={settings.localServer}
        options={[
          { value: "always", label: "Always" },
          { value: "while-open", label: "Only while PI Lab is open" },
          { value: "off", label: "Off (client only)" },
        ]}
        onChange={(next) => {
          if (next === "always" || next === "while-open" || next === "off") saveMode.mutate(next)
        }}
      />
      {saveMode.error ? (
        <p
          role="alert"
          data-testid="settings-local-server-error"
          className="px-4 py-3 text-destructive text-xs"
        >
          {saveMode.error.message}
        </p>
      ) : null}
      {showMachineUi(machines) ? (
        <SelectField
          testId="settings-default-machine"
          label="Default machine"
          description="Where New project creates a project unless you choose another machine."
          value={settings.defaultMachine ?? "local"}
          options={[
            ...(settings.localServer === "off" ? [] : [{ value: "local", label: "This Mac" }]),
            ...machines.map((machine) => ({ value: machine.machineId, label: machine.name })),
          ]}
          onChange={(next) => saveDefault.mutate(next === "local" ? null : next)}
        />
      ) : null}
      {saveDefault.error ? (
        <p role="alert" className="px-4 py-3 text-destructive text-xs">
          {saveDefault.error.message}
        </p>
      ) : null}
    </>
  )
}

const BEHIND_POLICY_KEY = ["desktop", "machines", "behindPolicy"] as const

/** "When a machine is behind this app": what this app does with a machine older than its server bundle. */
function BehindPolicyField() {
  const queryClient = useQueryClient()
  const policy = useQuery({
    queryKey: BEHIND_POLICY_KEY,
    queryFn: () => desktopIpc().desktop.machines.behindPolicy.query(),
  })
  const save = useMutation({
    mutationFn: (next: "auto" | "ask" | "never") =>
      desktopIpc().desktop.machines.setBehindPolicy.mutate({ policy: next }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BEHIND_POLICY_KEY })
      void queryClient.invalidateQueries({ queryKey: MACHINES_QUERY_KEY })
    },
  })
  if (policy.isError) throw policy.error
  if (policy.data === undefined) return null
  return (
    <>
      <SelectField
        testId="settings-machines-behind-policy"
        label="When a machine is behind this app"
        value={policy.data}
        options={[
          { value: "auto", label: "Update automatically" },
          { value: "ask", label: "Ask me" },
          { value: "never", label: "Never" },
        ]}
        onChange={(next) => {
          if (next === "auto" || next === "ask" || next === "never") save.mutate(next)
        }}
      />
      {save.error ? (
        <p role="alert" className="px-4 py-3 text-destructive text-xs">
          {save.error.message}
        </p>
      ) : null}
    </>
  )
}

/** "Update machines automatically" on one machine's server; only a server that updates itself shows it. */
function MachineAutoUpdate() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const canUpdate = useServerCapability(SERVER_UPDATE_CAPABILITY)
  const settings = useQuery({
    ...trpc.server.updates.settings.queryOptions(),
    enabled: canUpdate,
  })
  const save = useMutation(
    trpc.server.updates.setAutoUpdate.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.server.updates.settings.queryKey() }),
    }),
  )
  if (!canUpdate || settings.data === undefined) return null
  return (
    <>
      <ToggleField
        testId="settings-machine-auto-update"
        label="Update machines automatically"
        checked={settings.data.autoUpdate}
        disabled={save.isPending}
        onChange={(next) => save.mutate({ autoUpdate: next })}
      />
      {save.error ? (
        <p role="alert" className="px-4 py-3 text-destructive text-xs">
          {save.error.message}
        </p>
      ) : null}
    </>
  )
}

function MachineRow({
  machine,
  onRemoved,
}: {
  machine: MachineSummary
  onRemoved: (revoked: boolean) => void
}) {
  return (
    <div data-testid="settings-machine-block" data-machine-id={machine.machineId}>
      <MachineHeader machine={machine} onRemoved={onRemoved} />
      <MachineScope machineId={machine.machineId}>
        <MachineAutoUpdate />
      </MachineScope>
    </div>
  )
}

function MachineHeader({
  machine,
  onRemoved,
}: {
  machine: MachineSummary
  onRemoved: (revoked: boolean) => void
}) {
  const t = useTranslate()
  const queryClient = useQueryClient()
  const state = useMachineState(machine.machineId)
  const update = useMutation({
    mutationFn: () => desktopIpc().desktop.machines.update.mutate({ machineId: machine.machineId }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: MACHINES_QUERY_KEY }),
  })
  const remove = useMutation({
    mutationFn: () => desktopIpc().desktop.machines.remove.mutate({ machineId: machine.machineId }),
    onSuccess: (result) => {
      onRemoved(result.revoked)
      forgetCachedProjects(machine.machineId)
      void queryClient.invalidateQueries({ queryKey: MACHINES_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: DEVICE_SETTINGS_QUERY_KEY })
    },
  })
  return (
    <div
      data-testid="settings-machine"
      data-machine-id={machine.machineId}
      data-state={state}
      className="flex items-center justify-between gap-4 px-4 py-3"
    >
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-foreground text-sm">{machine.name}</span>
        <span className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
          <span
            className={cn("size-1.5 shrink-0 rounded-full", CONNECTION_DOTS[state])}
            aria-hidden
          />
          <span data-testid="settings-machine-state">{`${machine.sshHost} · ${t(CONNECTION_LABELS[state])}`}</span>
        </span>
        {machine.error && state !== "connected" ? (
          <span role="alert" className="text-destructive text-xs">
            {machine.error}
          </span>
        ) : null}
        {(machine.updateError ?? update.error?.message) && !machine.updating ? (
          <span
            role="alert"
            data-testid="settings-machine-update-error"
            className="text-destructive text-xs"
          >
            {machine.updateError ?? update.error?.message}
          </span>
        ) : null}
        {remove.error ? (
          <span role="alert" className="text-destructive text-xs">
            {remove.error.message}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {machine.updating ? (
          <span data-testid="settings-machine-updating">
            {machine.updateProgress ? (
              <InstallProgressText progress={machine.updateProgress} />
            ) : (
              <span className="text-muted-foreground text-xs">{t("Updating…")}</span>
            )}
          </span>
        ) : machine.updateAvailable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="settings-machine-update"
            disabled={update.isPending}
            onClick={() => update.mutate()}
          >
            {t("Update")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="settings-machine-remove"
          data-feature-label={t("Remove")}
          data-feature-help={t(
            "Forget this machine. Its token is revoked on the machine when it can be reached.",
          )}
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          {t("Remove")}
        </Button>
      </div>
    </div>
  )
}

const STEP_LABELS: Record<InstallProgress["step"], string> = {
  connecting: "Connecting…",
  copying: "Copying server",
  installing: "Installing server…",
  enrolling: "Starting and enrolling…",
}

/** Megabytes with one decimal, for the copy of the server bundle. */
function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1)
}

/** A spinner and the step of an add or update, with the megabytes copied during the copy. */
function InstallProgressText({ progress }: { progress: InstallProgress }) {
  const t = useTranslate()
  const label =
    progress.step === "copying"
      ? `${t(STEP_LABELS.copying)} ${megabytes(progress.sentBytes)} / ${megabytes(progress.totalBytes)} MB`
      : t(STEP_LABELS[progress.step])
  return (
    <span
      data-testid="settings-install-progress"
      data-step={progress.step}
      className="inline-flex items-center gap-1.5 text-muted-foreground text-xs"
    >
      <Loader2 className="size-3 animate-spin" aria-hidden />
      {label}
    </span>
  )
}

const ADD_PROGRESS_KEY = ["desktop", "machines", "addProgress"] as const

function AddMachineForm() {
  const t = useTranslate()
  const queryClient = useQueryClient()
  const [sshHost, setSshHost] = useState("")
  const [name, setName] = useState("")
  const hosts = useQuery({
    queryKey: ["desktop", "machines", "sshHosts"],
    queryFn: () => desktopIpc().desktop.machines.sshHosts.query(),
  })
  const add = useMutation({
    mutationFn: () => desktopIpc().desktop.machines.add.mutate({ sshHost, name }),
    // A new add starts without the last step of the previous one.
    onMutate: () => queryClient.setQueryData(ADD_PROGRESS_KEY, null),
    onSuccess: () => {
      setSshHost("")
      setName("")
      void queryClient.invalidateQueries({ queryKey: MACHINES_QUERY_KEY })
    },
  })
  const progress = useQuery({
    queryKey: ADD_PROGRESS_KEY,
    queryFn: () => desktopIpc().desktop.machines.addProgress.query(),
    enabled: add.isPending,
    refetchInterval: ADD_PROGRESS_REFRESH_MS,
  })
  // The suggestions are optional: when they cannot be read the field offers none and says why.
  const known = hosts.data ?? []
  // Choosing a Host from ~/.ssh/config fills an empty Name (or the one it filled before) with it.
  const chooseHost = (next: string) => {
    if (known.includes(next) && (name === "" || known.includes(name))) setName(next)
    setSshHost(next)
  }
  return (
    <div data-testid="settings-add-machine" className="flex flex-col">
      <TextField
        testId="settings-add-machine-host"
        label="SSH host"
        description="A host name, user@host, or a Host from ~/.ssh/config. If no PI Lab server runs there, PI Lab installs one."
        value={sshHost}
        placeholder="lab-server"
        suggestions={known}
        onChange={chooseHost}
      />
      {hosts.error ? (
        <p
          data-testid="settings-add-machine-hosts-error"
          className="px-4 pb-3 text-amber-600 text-xs dark:text-amber-400"
        >
          {`${t("Could not read ~/.ssh/config")}: ${hosts.error.message}`}
        </p>
      ) : null}
      <TextField
        testId="settings-add-machine-name"
        label="Name"
        description="How this machine is shown in PI Lab."
        value={name}
        placeholder="Lab server"
        onChange={setName}
      />
      <div className="flex items-center justify-end gap-3 px-4 py-3">
        {add.isPending ? (
          <InstallProgressText
            progress={progress.data ?? { step: "connecting", sentBytes: 0, totalBytes: 0 }}
          />
        ) : null}
        {add.error ? (
          <p
            role="alert"
            data-testid="settings-add-machine-error"
            className="text-destructive text-xs"
          >
            {add.error.message}
          </p>
        ) : null}
        <Button
          type="button"
          size="sm"
          data-testid="settings-add-machine-submit"
          disabled={add.isPending || sshHost.trim() === "" || name.trim() === ""}
          onClick={() => add.mutate()}
        >
          {add.isPending ? t("Adding…") : t("Add machine")}
        </Button>
      </div>
    </div>
  )
}

/** The devices allowed on this Mac's own server, with Revoke for the remote ones. */
function ThisMacDevices() {
  const t = useTranslate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const devices = useQuery(trpc.server.devices.list.queryOptions())
  const revoke = useMutation(
    trpc.server.devices.revoke.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.server.devices.list.queryKey() }),
    }),
  )
  return (
    <SettingsSection
      testId="settings-section-devices"
      title="Devices on this Mac"
      description="Other computers allowed to connect to this Mac's PI Lab server."
    >
      {devices.isError ? (
        <p role="alert" className="px-4 py-3 text-destructive text-sm">
          {devices.error.message}
        </p>
      ) : null}
      {(devices.data ?? []).map((device) => (
        <div
          key={device.id}
          data-testid="settings-device"
          data-device-id={device.id}
          data-revoked={device.revokedAt !== null}
          className="flex items-center justify-between gap-4 px-4 py-3"
        >
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-foreground text-sm">
              {device.local ? t("This Mac") : device.name}
            </span>
            <span className="text-muted-foreground text-xs">
              {device.revokedAt !== null
                ? t("Revoked")
                : `${t("Added")} ${new Date(device.createdAt).toLocaleDateString()}`}
            </span>
          </div>
          {device.local || device.revokedAt !== null ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="settings-device-revoke"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate({ id: device.id })}
            >
              {t("Revoke")}
            </Button>
          )}
        </div>
      ))}
      {revoke.error ? (
        <p role="alert" className="px-4 py-3 text-destructive text-xs">
          {revoke.error.message}
        </p>
      ) : null}
    </SettingsSection>
  )
}
