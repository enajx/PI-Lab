import { QueryClient } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"
import { setInterfaceLanguage } from "../../../../../../../i18n/language"
import { AppProviders } from "../../../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../../../test/fakeTrpcClient"
import { CreateAutomationForm } from "./CreateAutomationForm"

/**
 * Component test for the create-workflow form (md/engineering/testing-and-build.md): jsdom + a fake
 * tRPC client (the ScheduleBuilder fetches a live preview via
 * `automations.previewSchedule`). Asserts the schedule preview renders and that
 * submitting passes the collected values up.
 */

const PROJECTS = [{ id: "p1", name: "Repo", repoPath: "/tmp/repo" }]
const AGENTS = [
  {
    id: "claude-code",
    label: "Claude Code",
    available: true,
    executable: "/usr/bin/claude",
    oneShot: true,
  },
]

function renderForm(handlers: FakeHandlers, onSubmit = vi.fn(), onCancel = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = createFakeTrpcClient(handlers)
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <CreateAutomationForm
        projects={PROJECTS}
        agents={AGENTS}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    </AppProviders>,
  )
  return { onSubmit, onCancel }
}

const NEXT_RUN = Date.UTC(2026, 9, 15, 10, 30)
const validPreview: FakeHandlers = {
  "automations.previewSchedule": () => ({
    valid: true,
    summary: "Daily at 9:00 AM",
    upcoming: [NEXT_RUN],
  }),
}

describe("CreateAutomationForm", () => {
  afterEach(() => setInterfaceLanguage("en"))

  test("translates controls but keeps the schedule preview supplied by the service", async () => {
    act(() => setInterfaceLanguage("es"))
    renderForm(validPreview)
    expect(screen.getByRole("button", { name: "Crear flujo de trabajo" })).toBeTruthy()
    expect(screen.getByLabelText("Repetir")).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByTestId("schedule-preview-summary").textContent).toBe("Daily at 9:00 AM")
      expect(screen.getByTestId("schedule-preview").textContent).toContain(
        new Date(NEXT_RUN).toLocaleString("es"),
      )
    })
  })

  test("renders the schedule builder with a live preview", async () => {
    renderForm(validPreview)
    expect(screen.getByTestId("schedule-builder")).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByTestId("schedule-preview-summary").textContent).toBe("Daily at 9:00 AM")
    })
  })

  test("submitting passes the collected values up", async () => {
    const { onSubmit } = renderForm(validPreview)

    fireEvent.change(screen.getByTestId("automation-name-input"), {
      target: { value: "Nightly sweep" },
    })
    fireEvent.change(screen.getByTestId("automation-prompt"), {
      target: { value: "do the thing" },
    })
    fireEvent.click(screen.getByTestId("create-automation-submit"))

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1)
    })
    const values = onSubmit.mock.calls[0]?.[0]
    expect(values).toMatchObject({
      name: "Nightly sweep",
      prompt: "do the thing",
      projectId: "p1",
      agentId: "claude-code",
      executionMode: "interactive",
      recurrenceRule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
    })
    expect(typeof values.timezone).toBe("string")
  })

  test("submits the selected run-to-completion mode", async () => {
    const { onSubmit } = renderForm(validPreview)
    fireEvent.change(screen.getByTestId("automation-name-input"), {
      target: { value: "One-shot review" },
    })
    fireEvent.change(screen.getByTestId("automation-execution-mode"), {
      target: { value: "noninteractive" },
    })
    fireEvent.click(screen.getByTestId("create-automation-submit"))

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ executionMode: "noninteractive" }),
      ),
    )
  })

  test("switching to a weekly preset rewrites the rule", async () => {
    renderForm(validPreview)
    fireEvent.change(screen.getByTestId("schedule-mode"), { target: { value: "weekly" } })
    await waitFor(() => {
      expect(screen.getByTestId("schedule-weekday")).toBeTruthy()
    })
  })

  test("an invalid preview surfaces the invalid message", async () => {
    renderForm({
      "automations.previewSchedule": () => ({ valid: false, summary: "Custom", upcoming: [] }),
    })
    // Switch to custom so a raw (here, invalid) rule can be entered.
    fireEvent.change(screen.getByTestId("schedule-mode"), { target: { value: "custom" } })
    fireEvent.change(screen.getByTestId("schedule-rrule"), { target: { value: "garbage" } })
    await waitFor(() => {
      expect(screen.getByTestId("schedule-preview-invalid")).toBeTruthy()
    })
  })
})
