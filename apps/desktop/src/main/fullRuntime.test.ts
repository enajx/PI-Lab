import type { BrowserWindow } from "electron"
import { expect, test, vi } from "vitest"

const { reconcile, handler, database } = vi.hoisted(() => ({
  reconcile: vi.fn(),
  handler: vi.fn((_options: unknown) => ({ attachWindow: vi.fn() })),
  database: {},
}))
vi.mock("electron", () => ({
  app: { getPath: () => "/unused" },
  ipcMain: { on: vi.fn() },
  dialog: {},
  safeStorage: {},
  shell: {},
}))
vi.mock("trpc-electron/main", () => ({ createIPCHandler: handler }))
vi.mock("@pi-lab/local-db", () => ({
  getSettingsOrDefaults: () => ({ caffeine: {} }),
  projects: {},
}))
vi.mock("./db/db", () => ({
  getDb: () => database,
  initDatabase: () => ({ appliedCount: 23, latestTag: "latest", recovered: false }),
}))
vi.mock("./activity", () => ({
  ActivityRegistry: class {},
  createActivityMonitor: () => ({ reconcile }),
  systemActivityClock: {},
  systemActivityScheduler: {},
}))
vi.mock("./automations/dispatch", () => ({ dispatchAutomation: vi.fn() }))
vi.mock("./automations/scheduler", () => ({
  AutomationScheduler: class {
    start() {}
  },
}))
vi.mock("./caffeine", () => ({ CaffeineController: class {}, electronPowerSaveBlockerAdapter: {} }))
vi.mock("./i18n/nativeLanguage", () => ({
  getNativeLanguage: () => "en",
  saveNativeLanguage: vi.fn(),
}))
vi.mock("./notifications", () => ({
  NotificationService: class {},
  createNotificationBrokers: () => ({}),
  createElectronAppFocusAdapter: vi.fn(),
  createElectronNativeNotificationAdapter: vi.fn(),
}))
vi.mock("./python", () => ({
  livePythonProbe: vi.fn(),
  liveQuickPythonRuntimeResolver: vi.fn(),
  livePythonEnvironmentDiscoverer: vi.fn(),
  livePythonRuntimeResolver: vi.fn(),
}))
vi.mock("./python/standaloneInterpreters", () => ({ liveStandalonePythonDiscoverer: vi.fn() }))
vi.mock("./quickEdit/pythonRun", () => ({ QuickPythonRunner: class {} }))
vi.mock("./terminal/supervisor", () => ({ TerminalSupervisor: class {} }))
vi.mock("./trpc/appRouter", () => ({ appRouter: {} }))
vi.mock("./trpc/science/analysis/interactiveController", () => ({
  AnalysisInteractiveController: class {
    installProtocolHandler() {}
  },
}))
vi.mock("./trpc/template", () => ({ seedWritableTemplate: async () => {} }))
vi.mock("./window/appMenu", () => ({ installAppMenu: vi.fn() }))

import { FullRuntime } from "./fullRuntime"

test("the window opens while reconciliation is pending and IPC launch context waits", async () => {
  let finish: (() => void) | undefined
  reconcile.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve
    }),
  )
  const window = {} as BrowserWindow
  const initialWindow = vi.fn(() => window)
  const runtime = new FullRuntime({
    getAppIconPath: () => null,
    ensureMainWindow: () => window,
    initialWindow,
  })
  const startedAt = performance.now()
  const start = runtime.start()
  expect(initialWindow).toHaveBeenCalledTimes(1)
  const windowAt = performance.now() - startedAt
  const options = handler.mock.calls[0]?.[0] as unknown as { createContext: () => Promise<unknown> }
  let contextReady = false
  const context = options.createContext().then(() => {
    contextReady = true
  })
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(contextReady).toBe(false)
  finish?.()
  await start
  await context
  expect(contextReady).toBe(true)
  console.info("Controlled startup:", {
    windowMs: windowAt,
    reconciledMs: performance.now() - startedAt,
  })
})

test("a reconciliation failure leaves read-only IPC usable and rejects agent launch preparation", async () => {
  handler.mockClear()
  reconcile.mockRejectedValue(new Error("Daemon adoption failed"))
  const window = {} as BrowserWindow
  const runtime = new FullRuntime({
    getAppIconPath: () => null,
    ensureMainWindow: () => window,
    initialWindow: () => window,
  })
  await runtime.start()
  const options = handler.mock.calls[0]?.[0] as {
    createContext: () => Promise<{ getAgentLaunchEnvironment: () => Promise<unknown> }>
  }
  const context = await options.createContext()
  const outcome = await context.getAgentLaunchEnvironment().then(
    () => "launch allowed",
    (error: Error) => error.message,
  )
  expect(outcome).toBe("Daemon adoption failed")
})
