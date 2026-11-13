import { QueryClient } from "@tanstack/react-query"
import { afterEach, describe, expect, test, vi } from "vitest"
import { AppProviders } from "../../../../providers/AppProviders"
import { createFakeTrpcClient } from "../../../../test/fakeTrpcClient"
import { fireEvent, render, screen } from "../../../../test/render"
import { IssueReportControl } from "./IssueReportControl"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("IssueReportControl", () => {
  test("each menu item opens its GitHub issue form with the environment prefilled", async () => {
    const client = createFakeTrpcClient({
      "system.appInfo": () => ({ version: "0.9.1", channel: "beta", macosVersion: "15.4.1" }),
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    render(
      <AppProviders client={client} queryClient={queryClient}>
        <IssueReportControl />
      </AppProviders>,
    )

    fireEvent.click(screen.getByTestId("issue-report-control"))
    fireEvent.click(screen.getByRole("menuitem", { name: "Report a bug" }))
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    expect(open).toHaveBeenLastCalledWith(
      "https://github.com/enajx/PI-Lab/issues/new?template=bug_report.yml&environment=PI+Lab+0.9.1+%28Beta%29%2C+macOS+15.4.1",
      "_blank",
    )

    fireEvent.click(screen.getByTestId("issue-report-control"))
    fireEvent.click(screen.getByRole("menuitem", { name: "Request a feature" }))
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2))
    expect(open).toHaveBeenLastCalledWith(
      "https://github.com/enajx/PI-Lab/issues/new?template=feature_request.yml&environment=PI+Lab+0.9.1+%28Beta%29%2C+macOS+15.4.1",
      "_blank",
    )
  })
})
