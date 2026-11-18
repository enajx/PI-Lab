import { Button, cn } from "@pi-lab/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { SERVER_UPDATE_CAPABILITY } from "../../../../../shared/clientApi"
import { useTranslate } from "../../../../i18n/language"
import { CONNECTION_DOTS, CONNECTION_LABELS } from "../../../../machines/MachineControls"
import {
  forgetCachedProjects,
  MACHINES_QUERY_KEY,
  MachineScope,
  type MachineSummary,
  useMachineState,
  useMachines,
} from "../../../../machines/machines"
import { desktopIpc } from "../../../../trpc/client"
import { useTRPC } from "../../../../trpc/react"
import { useServerCapability } from "../../../../trpc/serverCapabilities"
import { SelectField, SettingsSection, TextField, ToggleField } from "./SettingsControls"

/** How often the page reads the machines' state from Electron main (errors of the last attempt). */
const MACHINES_REFRESH_MS = 2_000

/**
 * Settings > Machines: the remote machines this app connects to (add over
 * SSH, remove), and the devices allowed on this Mac's own server (revoke).
 */
export function MachinesSection() {
  const t = useTranslate()
  const machines = useMachines(MACHINES_REFRESH_MS)
  const [notice, setNotice] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        testId="settings-section-machines"
        title="Machines"
        description="Other computers whose PI Lab server this app connects to over SSH."
      >
        {machines === null ? null : machines.length === 0 ? (
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
        <BehindPolicyField />
        <AddMachineForm />
      </SettingsSection>
      <ThisMacDevices />
    </div>
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
          <span data-testid="settings-machine-updating" className="text-muted-foreground text-xs">
            {t("Updating…")}
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

function AddMachineForm() {
  const t = useTranslate()
  const queryClient = useQueryClient()
  const [sshHost, setSshHost] = useState("")
  const [name, setName] = useState("")
  const add = useMutation({
    mutationFn: () => desktopIpc().desktop.machines.add.mutate({ sshHost, name }),
    onSuccess: () => {
      setSshHost("")
      setName("")
      void queryClient.invalidateQueries({ queryKey: MACHINES_QUERY_KEY })
    },
  })
  return (
    <div data-testid="settings-add-machine" className="flex flex-col">
      <TextField
        testId="settings-add-machine-host"
        label="SSH host"
        description="A host name, user@host, or a Host from ~/.ssh/config. If no PI Lab server runs there, PI Lab installs one."
        value={sshHost}
        placeholder="lab-server"
        onChange={setSshHost}
      />
      <TextField
        testId="settings-add-machine-name"
        label="Name"
        description="How this machine is shown in PI Lab."
        value={name}
        placeholder="Lab server"
        onChange={setName}
      />
      <div className="flex items-center justify-end gap-3 px-4 py-3">
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
