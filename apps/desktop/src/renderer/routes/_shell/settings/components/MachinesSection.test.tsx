import { QueryClient } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { setDeviceSettingsSourceForTests } from "../../../../machines/machines"
import { AppProviders } from "../../../../providers/AppProviders"
import { createFakeTrpcClient } from "../../../../test/fakeTrpcClient"
import { MachinesSection } from "./MachinesSection"

vi.mock("../../../../trpc/client", () => ({
  desktopIpc: () => ({
    desktop: {
      machines: {
        behindPolicy: { query: () => Promise.resolve("ask") },
        sshHosts: { query: () => Promise.reject(new Error("EACCES: permission denied")) },
      },
    },
  }),
}))

afterEach(() =>
  setDeviceSettingsSourceForTests(async () => ({
    localServer: "always",
    defaultMachine: null,
    multiMachine: false,
  })),
)

/** Mocked IPC: a failed read of ~/.ssh/config shows a line under the SSH host field, which stays usable. */
test("a failed read of the ssh config hosts shows an error under the SSH host field", async () => {
  setDeviceSettingsSourceForTests(async () => ({
    localServer: "always",
    defaultMachine: null,
    multiMachine: true,
  }))
  const client = createFakeTrpcClient({ "server.devices.list": () => [] })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <AppProviders client={client} queryClient={queryClient}>
      <MachinesSection />
    </AppProviders>,
  )
  const error = await screen.findByTestId("settings-add-machine-hosts-error")
  expect(error.textContent).toBe("Could not read ~/.ssh/config: EACCES: permission denied")
  expect(screen.getByTestId("settings-add-machine-host").hasAttribute("disabled")).toBe(false)
  queryClient.clear()
})
