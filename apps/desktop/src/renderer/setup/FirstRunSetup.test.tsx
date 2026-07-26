import { QueryClient } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { AppProviders } from "../providers/AppProviders"
import { createFakeTrpcClient } from "../test/fakeTrpcClient"
import { FirstRunSetup } from "./FirstRunSetup"

const ENVIRONMENT = {
  harnesses: [
    { id: "claude-code", label: "Claude Code", executable: "claude", state: "authenticated" },
    { id: "codex", label: "Codex", executable: "codex", state: "missing" },
  ],
  github: { executable: "gh", state: "authenticated", account: "octo", connectivity: "available" },
  zotero: "installed",
  apiConfigured: { "claude-code": false, codex: false },
} as const

function renderSetup(
  handlers: Record<string, (input: unknown) => unknown | Promise<unknown>>,
  onClose = vi.fn(),
) {
  const client = createFakeTrpcClient({
    "setup.environment": () => ENVIRONMENT,
    "settings.get": () => ({
      agents: { projectConfigStorage: "app", executableOverrides: {}, setupCompleted: false },
    }),
    ...handlers,
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <FirstRunSetup onClose={onClose} />
    </AppProviders>,
  )
  return { onClose }
}

beforeEach(() => window.localStorage.clear())

describe("FirstRunSetup", () => {
  test("shows compact detected subscriptions and automatically chooses the only detected agent", async () => {
    renderSetup({})

    expect(await screen.findByText("Detected")).toBeTruthy()
    expect(screen.getByText("Not detected")).toBeTruthy()
    expect(await screen.findByText("Default agent")).toBeTruthy()
    expect(screen.getByText("GitHub")).toBeTruthy()
    expect(screen.getByText("Zotero")).toBeTruthy()
    expect(screen.queryByText(/Chat mode/u)).toBeNull()
    expect(screen.queryByText(/Executable path/u)).toBeNull()
    expect(screen.queryByText(/Log in/u)).toBeNull()
  })

  test("renders local integrations as cards and makes a failed Codex check retryable", async () => {
    const environment = vi.fn(() => ({
      ...ENVIRONMENT,
      harnesses: ENVIRONMENT.harnesses.map((harness) =>
        harness.id === "codex"
          ? {
              ...harness,
              state: "error" as const,
              message: "Codex returned an unknown status",
            }
          : harness,
      ),
    }))
    renderSetup({ "setup.environment": environment })

    expect(await screen.findByText("Codex returned an unknown status")).toBeTruthy()
    expect(screen.getByText("Clone, push, and create pull requests.")).toBeTruthy()
    expect(screen.getByText("Use your local library as a research source.")).toBeTruthy()
    expect(screen.getByText("codex login status")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Retry detection" }))
    await waitFor(() => expect(environment).toHaveBeenCalledTimes(2))
  })

  test("reveals an API field only after explicit choice and never retains its value in the renderer", async () => {
    const saved: unknown[] = []
    renderSetup({
      "setup.saveApiKey": (input) => {
        saved.push(input)
        return { configured: true }
      },
    })

    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Use API instead" }))[0] as HTMLElement,
    )
    const input = screen.getByLabelText("Claude Code API key")
    expect(input.getAttribute("type")).toBe("password")
    fireEvent.change(input, { target: { value: "sk-local-secret" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(saved).toEqual([{ agentId: "claude-code", apiKey: "sk-local-secret" }]),
    )
    await waitFor(() => expect(screen.queryByLabelText("Claude Code API key")).toBeNull())
  })

  test("lets several detected subscriptions stay without a default", async () => {
    renderSetup({
      "setup.environment": () => ({
        ...ENVIRONMENT,
        harnesses: ENVIRONMENT.harnesses.map((harness) => ({ ...harness, state: "authenticated" })),
      }),
    })

    expect(await screen.findByText("No default selected.")).toBeTruthy()
    fireEvent.click(screen.getAllByText("Detected")[1] as HTMLElement)
    expect(await screen.findByText("Default agent")).toBeTruthy()
    fireEvent.click(screen.getByText("Default agent"))
    expect(await screen.findByText("No default selected.")).toBeTruthy()
    expect(screen.queryByText("Do not set a default")).toBeNull()
  })

  test("keeps setup Appearance to Light/Dark and the Silent notification default", async () => {
    renderSetup({})
    const theme = await screen.findByLabelText<HTMLSelectElement>("Theme mode")
    expect(Array.from(theme.options).map((option) => option.value)).toEqual(["light", "dark"])
    expect(screen.getByLabelText("Completion sound")).toHaveProperty("value", "silent")
    expect(screen.queryByTestId("app-theme-gallery")).toBeNull()
  })

  test("finishes with the selected sound only after persistence succeeds", async () => {
    const completed: unknown[] = []
    const setup = renderSetup({
      "setup.complete": (input) => {
        completed.push(input)
        return { completed: true }
      },
    })
    await screen.findByRole("heading", { name: "Set up PI Lab" })
    fireEvent.change(screen.getByLabelText("Completion sound"), { target: { value: "success" } })
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }))
    await waitFor(() => expect(completed).toEqual([{ sound: "success" }]))
    expect(setup.onClose).toHaveBeenCalledOnce()
  })
})
