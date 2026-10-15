import { protocol } from "electron"

export const REPORT_SCHEME = "pi-lab-report"

/** Register the report URL scheme before Electron becomes ready. */
export function registerAnalysisReportScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: REPORT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ])
}
