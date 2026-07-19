import { QueryClient } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { AppProviders } from "../../../providers/AppProviders"
import { createFakeTrpcClient } from "../../../test/fakeTrpcClient"
import { ProjectWorkspace } from "./$projectId"

describe("Project header", () => {
  test("renders the shared Caffeine control while the workspace opens", async () => {
    const client = createFakeTrpcClient({
      "caffeine.status": () => ({ mode: "off", scope: "system-only", held: false }),
      "projects.get": () => ({
        id: "p1",
        name: "Photon Drift",
        repoPath: "/tmp/photon-drift",
      }),
      "settings.get": () => ({}),
      "workspaces.ensureMain": () => new Promise(() => {}),
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <AppProviders client={client} queryClient={queryClient}>
        <ProjectWorkspace projectId="p1" activation={{}} />
      </AppProviders>,
    )

    const control = await screen.findByTestId("caffeine-control")
    expect(control.closest("header")).toBeTruthy()
    expect(await screen.findByRole("heading", { name: "Photon Drift" })).toBeTruthy()
  })
})
