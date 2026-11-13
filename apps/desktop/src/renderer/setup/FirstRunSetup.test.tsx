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

/** Each setup row has its own check: harness rows, GitHub and Zotero. */
const ROW_HANDLERS = {
  "setup.harnesses": () => ({
    harnesses: ENVIRONMENT.harnesses,
    apiConfigured: ENVIRONMENT.apiConfigured,
  }),
  "setup.github": () => ENVIRONMENT.github,
  "setup.zotero": () => ENVIRONMENT.zotero,
}

function renderSetup(
  handlers: Record<string, (input: unknown) => unknown | Promise<unknown>>,
  onClose = vi.fn(),
) {
  const client = createFakeTrpcClient({
    "settings.updateAgents": (input) => input,
    // The wizard sizes the window to its content while it is shown.
    "system.fitWindowToContent": () => undefined,
    "system.restoreWindowSize": () => undefined,
    ...ROW_HANDLERS,
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
  test("keeps the initialized Beta choice and saves a Stable choice for future updates", async () => {
    const previous = window.piLab
    window.piLab = {
      ...previous,
      appIcon: { ...previous?.appIcon, getChannel: async () => "stable" },
    } as NonNullable<typeof window.piLab>
    const update = vi.fn((input: unknown) => input)
    try {
      renderSetup({
        "settings.get": () => ({
          publicUpdateChannel: "beta",
          agents: { setupCompleted: false },
        }),
        "settings.updateGeneral": update,
      })
      const channel = await screen.findByLabelText<HTMLSelectElement>("Update channel")
      expect(channel.value).toBe("beta")
      expect(update).not.toHaveBeenCalled()
      fireEvent.change(channel, { target: { value: "stable" } })
      await waitFor(() => expect(update).toHaveBeenCalledWith({ publicUpdateChannel: "stable" }))
    } finally {
      window.piLab = previous
    }
  })

  test("does not offer public update channels in Alpha", async () => {
    const previous = window.piLab
    const getChannel = vi.fn(async () => "alpha" as const)
    window.piLab = {
      ...previous,
      appIcon: { ...previous?.appIcon, getChannel },
    } as NonNullable<typeof window.piLab>
    try {
      renderSetup({})
      await waitFor(() => expect(getChannel).toHaveBeenCalled())
      expect(screen.queryByLabelText("Update channel")).toBeNull()
    } finally {
      window.piLab = previous
    }
  })

  test("shows a channel save error and keeps the saved choice", async () => {
    const previous = window.piLab
    window.piLab = {
      ...previous,
      appIcon: { ...previous?.appIcon, getChannel: async () => "stable" },
    } as NonNullable<typeof window.piLab>
    try {
      renderSetup({
        "settings.get": () => ({
          publicUpdateChannel: "beta",
          agents: { setupCompleted: false },
        }),
        "settings.updateGeneral": () => {
          throw new Error("Could not save update channel")
        },
      })
      const channel = await screen.findByLabelText<HTMLSelectElement>("Update channel")
      fireEvent.change(channel, { target: { value: "stable" } })
      expect(await screen.findByText("Could not save update channel")).toBeTruthy()
      expect(channel.value).toBe("beta")
    } finally {
      window.piLab = previous
    }
  })

  test("changes interface language during setup and persists the choice", async () => {
    renderSetup({})
    const language = await screen.findByLabelText<HTMLSelectElement>("Language")
    expect(Array.from(language.options).map((option) => option.value)).toEqual([
      "en",
      "zh-CN",
      "ko",
      "ja",
      "es",
      "ar",
      "nb",
    ])
    fireEvent.change(language, { target: { value: "es" } })
    expect(await screen.findByRole("heading", { name: "Configurar PI Lab" })).toBeTruthy()
    expect(window.localStorage.getItem("pi-lab.interface.language")).toBe("es")
  })

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

  test("shows Checking… instead of Not detected until the environment check finishes", async () => {
    let resolveHarnesses: (value: unknown) => void = () => undefined
    let resolveGithub: (value: unknown) => void = () => undefined
    let resolveZotero: (value: unknown) => void = () => undefined
    renderSetup({
      "setup.harnesses": () => new Promise((resolve) => (resolveHarnesses = resolve)),
      "setup.github": () => new Promise((resolve) => (resolveGithub = resolve)),
      "setup.zotero": () => new Promise((resolve) => (resolveZotero = resolve)),
    })

    expect((await screen.findAllByText("Checking…")).length).toBe(4)
    expect(screen.queryByText("Not detected")).toBeNull()
    expect(screen.queryByText("Detected")).toBeNull()
    expect(screen.queryByText("Not found")).toBeNull()

    resolveHarnesses(ROW_HANDLERS["setup.harnesses"]())
    resolveGithub(ENVIRONMENT.github)
    resolveZotero(ENVIRONMENT.zotero)
    expect(await screen.findByText("Detected")).toBeTruthy()
    expect(screen.getByText("Not detected")).toBeTruthy()
    expect(screen.getByText("octo")).toBeTruthy()
    expect(screen.queryByText("Checking…")).toBeNull()
  })

  test("each row shows its own result while a slower check still says Checking…", async () => {
    let resolveGithub: (value: unknown) => void = () => undefined
    renderSetup({ "setup.github": () => new Promise((resolve) => (resolveGithub = resolve)) })

    expect(await screen.findByText("Detected")).toBeTruthy()
    expect(screen.getByText("Not detected")).toBeTruthy()
    expect(screen.getByText("Installed")).toBeTruthy()
    expect(screen.getAllByText("Checking…")).toHaveLength(1)
    expect(screen.queryByText("octo")).toBeNull()

    resolveGithub(ENVIRONMENT.github)
    expect(await screen.findByText("octo")).toBeTruthy()
    expect(screen.queryByText("Checking…")).toBeNull()
  })

  test("shows Checking… again while Recheck runs", async () => {
    let checking = false
    const releases: (() => void)[] = []
    /** Answer at once on the first check; on a recheck, wait until released. */
    const held = (value: () => unknown) => (): unknown =>
      checking ? new Promise((resolve) => releases.push(() => resolve(value()))) : value()
    renderSetup({
      "setup.harnesses": held(ROW_HANDLERS["setup.harnesses"]),
      "setup.github": held(ROW_HANDLERS["setup.github"]),
      "setup.zotero": held(ROW_HANDLERS["setup.zotero"]),
    })
    expect(await screen.findByText("Detected")).toBeTruthy()
    checking = true
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }))
    expect((await screen.findAllByText("Checking…")).length).toBe(4)
    for (const release of releases) release()
    await waitFor(() => expect(screen.queryByText("Checking…")).toBeNull())
    expect(screen.getByText("Not detected")).toBeTruthy()
  })

  test("renders local integrations as cards and makes a failed Codex check retryable", async () => {
    const harnesses = vi.fn(() => ({
      apiConfigured: ENVIRONMENT.apiConfigured,
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
    renderSetup({ "setup.harnesses": harnesses })

    expect(await screen.findByText("Codex returned an unknown status")).toBeTruthy()
    expect(screen.getByText("Clone, push, and create pull requests.")).toBeTruthy()
    expect(screen.getByText("Use your local library as a research source.")).toBeTruthy()
    expect(screen.getByText("codex login status")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Retry detection" }))
    await waitFor(() => expect(harnesses).toHaveBeenCalledTimes(2))
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
      "setup.harnesses": () => ({
        apiConfigured: ENVIRONMENT.apiConfigured,
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

  test("offers Start at login off by default and applies a change before setup ends", async () => {
    const loginPatches: unknown[] = []
    renderSetup({
      "system.startAtLogin": () => ({ enabled: false }),
      "system.setStartAtLogin": (input) => {
        loginPatches.push(input)
        return input
      },
    })
    const toggle = await screen.findByTestId("setup-start-at-login")
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    fireEvent.click(toggle)
    await waitFor(() => expect(loginPatches).toContainEqual({ enabled: true }))
  })

  test("has no dictation section and shows Start at login in the last card", async () => {
    renderSetup({ "system.startAtLogin": () => ({ enabled: false }) })
    const toggle = await screen.findByTestId("setup-start-at-login")
    expect(screen.queryByTestId("first-run-dictation")).toBeNull()
    const cards = screen.getByTestId("first-run-setup-scroll").querySelectorAll("section")
    expect(cards[cards.length - 1]?.contains(toggle)).toBe(true)
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
    await waitFor(() => expect(setup.onClose).toHaveBeenCalledOnce())
  })
})
