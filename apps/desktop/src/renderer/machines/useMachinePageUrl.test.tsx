import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { expect, test, vi } from "vitest"
import { useMachinePageUrl } from "./useMachinePageUrl"

const forwardPort = vi.fn()

vi.mock("../trpc/client", () => ({
  desktopIpc: () => ({ desktop: { machines: { forwardPort: { mutate: forwardPort } } } }),
}))
vi.mock("./machines", () => ({ useMachineScope: () => ({ machineId: "machine-1" }) }))

/** Mocked IPC: after the forward reconnects on another local port, the page URL follows it. */
test("a notebook page follows the forward to its new local port", async () => {
  forwardPort.mockResolvedValue({ localPort: 41001 })
  const queryClient = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const view = renderHook(() => useMachinePageUrl("http://127.0.0.1:8888/lab"), { wrapper })
  await waitFor(() => expect(view.result.current.url).toBe("http://127.0.0.1:41001/lab"))
  forwardPort.mockResolvedValue({ localPort: 41002 })
  await waitFor(() => expect(view.result.current.url).toBe("http://127.0.0.1:41002/lab"), {
    timeout: 8_000,
  })
  expect(forwardPort).toHaveBeenCalledWith({ machineId: "machine-1", port: 8888 })
  queryClient.clear()
}, 15_000)
