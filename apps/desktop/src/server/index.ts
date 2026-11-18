import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { MigrationFailure } from "@pi-lab/local-db"
import {
  analysisMedia,
  MEDIA_SCHEME,
  REPORT_SCHEME,
} from "../main/trpc/science/analysis/mediaGrants"
import {
  DISCOVERY_FILE,
  ensureLocalToken,
  readDiscovery,
  TOKEN_HEADER,
  writeDiscovery,
} from "./access"
import { readServerConfig } from "./config"
import { listen } from "./http"
import { ServerRuntime } from "./runtime"

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

  const token = ensureLocalToken(config.dataDir)
  // A server.json left by a crash can name a pid that now belongs to another
  // process, so only a server that answers with our token counts as running.
  const existing = readDiscovery(config.dataDir)
  if (existing && existing.pid !== process.pid && (await answers(existing.port, token))) {
    console.error(`[pi-lab server] another server (pid ${existing.pid}) serves ${config.dataDir}`)
    process.exit(0)
  }

  const runtime = new ServerRuntime(config)
  await runtime.start()

  let stopping = false
  const stop = (code: number): void => {
    if (stopping) return
    stopping = true
    rmSync(join(config.dataDir, DISCOVERY_FILE), { force: true })
    void server
      .close()
      .catch((error: unknown) => console.error("[pi-lab server] close failed:", error))
      .finally(() => {
        runtime.dispose()
        process.exit(code)
      })
  }

  const server = await listen({
    port: config.port,
    token,
    createContext: () => ({
      ...runtime.createAppContext(),
      server: { runtime, exit: () => setImmediate(() => stop(0)) },
    }),
    handleScheme: (scheme, request) => {
      if (scheme === REPORT_SCHEME) return runtime.analysisInteractive.handleReportRequest(request)
      if (scheme === MEDIA_SCHEME) return analysisMedia.handle(request)
      return Promise.resolve(new Response(null, { status: 404 }))
    },
  })
  writeDiscovery(config.dataDir, { port: server.port, pid: process.pid, build: config.build })
  console.log(`[pi-lab server] listening on 127.0.0.1:${server.port} (pid ${process.pid})`)

  process.on("SIGTERM", () => stop(0))
  process.on("SIGINT", () => stop(0))
}

/** True when a PI Lab server on this port accepts our token. */
async function answers(port: number, token: string): Promise<boolean> {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { [TOKEN_HEADER]: token },
    signal: AbortSignal.timeout(2_000),
  }).catch(() => null)
  return response?.ok === true
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
