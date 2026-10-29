import { QueryClient } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { afterEach, describe, expect, test } from "vitest"
import { AppProviders } from "../../../providers/AppProviders"
import { createFakeTrpcClient } from "../../../test/fakeTrpcClient"
import { act, fireEvent, render, screen } from "../../../test/render"
import { useEscapeToDashboard } from "./-escapeToDashboard"
import { ProjectWorkspace } from "./-ProjectWorkspace"

/**
 * Escape in the project view returns to the Projects Dashboard, unless focus is in a
 * terminal, an editor or a text field, or an overlay takes the key first. The project
 * route below mirrors `$projectId.tsx` (the hook plus the workspace) inside a memory
 * router whose "/" is a Dashboard stand-in.
 */
function renderProjectRoute() {
  const client = createFakeTrpcClient({
    "caffeine.status": () => ({ mode: "off", scope: "system-only", held: false }),
    "projects.get": () => ({ id: "p1", name: "Photon Drift", repoPath: "/tmp/photon-drift" }),
    "projects.touch": () => ({}),
    "projects.capabilities": () => ({ git: true }),
    "settings.get": () => ({}),
    "workflows.status": () => ({ planResearch: null, fetchExperiments: null }),
    // Keep the view on "Opening project…": the Escape handling does not depend on it.
    "workspaces.ensureMain": () => new Promise(() => {}),
  })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute()
  const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div data-testid="dashboard" />,
  })
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/projects/$projectId",
    component: function ProjectRoute() {
      useEscapeToDashboard()
      return <ProjectWorkspace projectId="p1" activation={{}} />
    },
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([dashboardRoute, projectRoute]),
    history: createMemoryHistory({ initialEntries: ["/projects/p1"] }),
  })
  render(
    <AppProviders client={client} queryClient={queryClient}>
      {/* biome-ignore lint/suspicious/noExplicitAny: test router type plumbing. */}
      <RouterProvider router={router as any} />
    </AppProviders>,
  )
  return router
}

/** Add `element` inside the project view and focus it. */
async function focusInsideProjectView(element: HTMLElement): Promise<HTMLElement> {
  const view = await screen.findByTestId("project-view")
  view.appendChild(element)
  element.focus()
  return element
}

/** Let any navigation the key started settle, then assert the view stayed. */
async function expectStillOnProject(router: ReturnType<typeof renderProjectRoute>) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  expect(router.state.location.pathname).toBe("/projects/p1")
  expect(screen.queryByTestId("dashboard")).toBeNull()
}

afterEach(() => {
  for (const node of document.querySelectorAll("[data-escape-test]")) node.remove()
})

describe("Escape in the project view", () => {
  test("returns to the Projects Dashboard", async () => {
    const router = renderProjectRoute()
    await screen.findByTestId("project-view")
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(await screen.findByTestId("dashboard")).toBeTruthy()
    expect(router.state.location.pathname).toBe("/")
  })

  test.each([
    ["an input", () => document.createElement("input")],
    ["a textarea", () => document.createElement("textarea")],
    ["a select", () => document.createElement("select")],
    [
      "a contenteditable editor",
      () => {
        const editor = document.createElement("div")
        editor.setAttribute("contenteditable", "true")
        editor.tabIndex = 0
        return editor
      },
    ],
  ])("keeps the project view when focus is in %s", async (_label, create) => {
    const router = renderProjectRoute()
    const target = await focusInsideProjectView(create())
    fireEvent.keyDown(target, { key: "Escape" })
    await expectStillOnProject(router)
  })

  test("leaves Escape to the terminal so agents can be interrupted", async () => {
    const router = renderProjectRoute()
    const xterm = document.createElement("div")
    xterm.className = "xterm"
    const helper = document.createElement("textarea")
    helper.className = "xterm-helper-textarea"
    xterm.appendChild(helper)
    await focusInsideProjectView(xterm)
    helper.focus()
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    helper.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    await expectStillOnProject(router)
  })

  test("leaves Escape to an open dialog, even one that closes itself on Escape", async () => {
    const router = renderProjectRoute()
    await screen.findByTestId("project-view")
    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    dialog.dataset.escapeTest = ""
    document.body.appendChild(dialog)
    // Like the app's own popups: close on Escape without preventDefault.
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") dialog.remove()
    }
    document.addEventListener("keydown", close)
    try {
      fireEvent.keyDown(document.body, { key: "Escape" })
      expect(document.body.contains(dialog)).toBe(false)
      await expectStillOnProject(router)
    } finally {
      document.removeEventListener("keydown", close)
    }
  })

  test("does not navigate when an inner handler already handled Escape", async () => {
    const router = renderProjectRoute()
    const button = document.createElement("button")
    button.addEventListener("keydown", (event) => event.preventDefault())
    await focusInsideProjectView(button)
    fireEvent.keyDown(button, { key: "Escape" })
    await expectStillOnProject(router)
  })
})
