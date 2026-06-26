import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../../../../providers/AppProviders"
import { createFakeTrpcClient, type FakeHandlers } from "../../../../../../../test/fakeTrpcClient"
import { CreateAutomationForm } from "./CreateAutomationForm"

/**
 * Component test for the create-workflow form (docs/testing-and-build.md): jsdom + a fake
 * tRPC client (the ScheduleBuilder fetches a live preview via
 * `automations.previewSchedule`). Asserts the schedule preview renders and that
 * submitting passes the collected values up.
 */

const PROJECTS = [{ id: "p1", name: "Repo", repoPath: "/tmp/repo" }]
const AGENTS = [{ id: "claude-code", label: "Claude Code" }]

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

const validPreview: FakeHandlers = {
  "automations.previewSchedule": () => ({
    valid: true,
    summary: "Daily at 9:00 AM",
    upcoming: [Date.now() + 3_600_000],
  }),
}

describe("CreateAutomationForm", () => {
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
      recurrenceRule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
    })
    expect(typeof values.timezone).toBe("string")
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
