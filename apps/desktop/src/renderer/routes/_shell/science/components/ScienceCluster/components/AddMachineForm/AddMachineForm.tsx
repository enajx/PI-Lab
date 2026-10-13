import { Button, Input, Label } from "@pi-lab/ui"
import { useState } from "react"
import { useTranslate } from "../../../../../../../i18n/language"

export interface AddMachineValues {
  host: string
  hostname?: string
  user?: string
  port?: number
  label?: string
}

interface AddMachineFormProps {
  onSubmit: (values: AddMachineValues) => void
  onCancel: () => void
  /** True while the add mutation is in flight. */
  isPending?: boolean
  /** Error from a failed add (e.g. a duplicate host), shown inline. */
  error?: string | null
}

/**
 * Inline form to register a machine by hand (AGENTS.md "Scope" — Cluster monitoring).
 * Deliberately a plain inline panel rather than a Radix dialog so it renders and
 * is assertable under jsdom (md/engineering/testing-and-build.md). Only `host` is required; the rest is
 * optional connection metadata. ssh key material is never collected here.
 */
export function AddMachineForm({ onSubmit, onCancel, isPending, error }: AddMachineFormProps) {
  const t = useTranslate()
  const [host, setHost] = useState("")
  const [hostname, setHostname] = useState("")
  const [user, setUser] = useState("")
  const [port, setPort] = useState("")
  const [label, setLabel] = useState("")

  const submit = () => {
    const trimmedHost = host.trim()
    if (trimmedHost.length === 0) return
    const portNum = Number.parseInt(port, 10)
    onSubmit({
      host: trimmedHost,
      hostname: hostname.trim() || undefined,
      user: user.trim() || undefined,
      port: Number.isInteger(portNum) && portNum > 0 ? portNum : undefined,
      label: label.trim() || undefined,
    })
  }

  return (
    <form
      data-testid="add-machine-form"
      className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-4"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id="add-host" label={t("Host alias")} required>
          <Input
            id="add-host"
            data-testid="add-host-input"
            autoFocus
            value={host}
            placeholder="gpu-box"
            onChange={(e) => setHost(e.target.value)}
          />
        </Field>
        <Field id="add-hostname" label={t("HostName (optional)")}>
          <Input
            id="add-hostname"
            value={hostname}
            placeholder="10.0.0.5"
            onChange={(e) => setHostname(e.target.value)}
          />
        </Field>
        <Field id="add-user" label={t("User (optional)")}>
          <Input
            id="add-user"
            value={user}
            placeholder="researcher"
            onChange={(e) => setUser(e.target.value)}
          />
        </Field>
        <Field id="add-port" label={t("Port (optional)")}>
          <Input
            id="add-port"
            type="number"
            value={port}
            placeholder="22"
            onChange={(e) => setPort(e.target.value)}
          />
        </Field>
        <Field id="add-label" label={t("Label (optional)")}>
          <Input
            id="add-label"
            value={label}
            placeholder="8×A100 Slurm box"
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
      </div>

      {error ? <p className="cursor-text select-text text-destructive text-xs">{error}</p> : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("Cancel")}
        </Button>
        <Button
          type="submit"
          size="sm"
          data-testid="add-machine-submit"
          disabled={isPending || host.trim().length === 0}
        >
          {t("Add machine")}
        </Button>
      </div>
    </form>
  )
}

function Field({
  id,
  label,
  required,
  children,
}: {
  id: string
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-muted-foreground text-xs">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {children}
    </div>
  )
}
