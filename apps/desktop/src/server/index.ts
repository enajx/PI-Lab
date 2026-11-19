import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getSettingsOrDefaults, MigrationFailure } from "@pi-lab/local-db"
import { getDb } from "../main/db/db"
import { isTestMode } from "../main/runtime/env"
import {
  analysisMedia,
  MEDIA_SCHEME,
  REPORT_SCHEME,
} from "../main/trpc/science/analysis/mediaGrants"
import {
  DISCOVERY_FILE,
  ensureLocalToken,
  newServerId,
  readDiscovery,
  serverAnswers,
  writeDiscovery,
} from "./access"
import { readServerConfig } from "./config"
import { listen } from "./http"
import { ServerRuntime } from "./runtime"
import { RELEASES_URL, ServerSelfUpdate } from "./selfUpdate"
import { writeStartStep } from "./startProgress"

/**
 * PI Lab server entry. Started by launchd (packaged app) or by the desktop app
 * (source and test runs) with the app binary in Node mode. Owns the database,
 * agents, routines and terminals, and serves clients over loopback.
 */
async function main(): Promise<void> {
  const config = readServerConfig(process.env)
  mkdirSync(config.dataDir, { recursive: true })
  // Shared modules read the data folder from the environment.
  process.env.PI_LAB_DATA_DIR = config.dataDir
  writeStartStep(config.dataDir, "starting")
  // E2E only: a slow start, as on a fully loaded machine.
  const testStartDelayMs = Number(process.env.PI_LAB_TEST_SERVER_START_DELAY_MS ?? "0")
  if (isTestMode && testStartDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, testStartDelayMs))
  }

  const token = ensureLocalToken(config.dataDir)
  // A server.json left by a crash can name a pid that now belongs to another
  // process, so only a server that answers with our token counts as running.
  const existing = readDiscovery(config.dataDir)
  if (existing && existing.pid !== process.pid && (await serverAnswers(existing, token))) {
    console.error(`[pi-lab server] another server (pid ${existing.pid}) serves ${config.dataDir}`)
    process.exit(0)
  }

  const runtime = new ServerRuntime(config)
  await runtime.start((step) => writeStartStep(config.dataDir, step))

  let selfUpdate: ServerSelfUpdate | null = null
  let stopping = false
  const stop = (code: number): void => {
    if (stopping) return
    stopping = true
    selfUpdate?.stop()
    rmSync(join(config.dataDir, DISCOVERY_FILE), { force: true })
    void server
      .close()
      .catch((error: unknown) => console.error("[pi-lab server] close failed:", error))
      .finally(() => {
        runtime.dispose()
        process.exit(code)
      })
  }

  const serverId = newServerId()
  const server = await listen({
    port: config.port,
    access: runtime.devices,
    localToken: token,
    createContext: () => ({
      ...runtime.createAppContext(),
      server: { runtime, exit: () => setImmediate(() => stop(0)) },
    }),
    handleScheme: (scheme, request) => {
      if (scheme === REPORT_SCHEME) return runtime.analysisInteractive.handleReportRequest(request)
      if (scheme === MEDIA_SCHEME) return analysisMedia.handle(request)
      return Promise.resolve(new Response(null, { status: 404 }))
    },
    testRoutes: process.env.PI_LAB_TEST_MODE === "1",
  })
  writeStartStep(config.dataDir, "listening")
  writeDiscovery(config.dataDir, {
    port: server.port,
    pid: process.pid,
    build: config.build,
    serverId,
  })
  console.log(`[pi-lab server] listening on 127.0.0.1:${server.port} (pid ${process.pid})`)

  // Test mode checks for updates only against a local feed the test serves.
  const testReleasesUrl = process.env.PI_LAB_TEST_SERVER_RELEASES_URL?.trim()
  if (!isTestMode || testReleasesUrl) {
    selfUpdate = new ServerSelfUpdate({
      config,
      channel: () => getSettingsOrDefaults(getDb()).publicUpdateChannel,
      releasesUrl: testReleasesUrl || RELEASES_URL,
      startDelayMs: isTestMode ? 0 : 10_000,
      log: (message) => console.log(message),
    })
    selfUpdate.start()
  }

  process.on("SIGTERM", () => stop(0))
  process.on("SIGINT", () => stop(0))
}

main().catch((error: unknown) => {
  console.error("[pi-lab server] fatal:", error)
  // The desktop app shows this to the user (main/server/launcher.ts).
  const dataDir = process.env.PI_LAB_DATA_DIR
  if (dataDir) {
    writeFileSync(
      join(dataDir, "server-error.json"),
      JSON.stringify({
        kind: error instanceof MigrationFailure ? "migration" : "other",
        message: error instanceof Error ? error.message : String(error),
      }),
    )
  }
  // Exit cleanly so launchd does not restart a server that cannot start; the
  // app shows the error and starts the server again on its next launch.
  process.exit(0)
})
