import { protocol } from "electron"
import { MEDIA_SCHEME } from "./mediaGrants"

export const REPORT_SCHEME = "pi-lab-report"

/**
 * Register the report URL scheme and the media scheme of video and gif
 * previews (`stream` lets `<video>` request byte ranges) before Electron
 * becomes ready.
 */
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
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ])
}
