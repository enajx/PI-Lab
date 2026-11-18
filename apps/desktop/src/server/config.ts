import type { PiLabChannel } from "../main/identity/channel"

/**
 * Everything the server needs to know about its install, passed by whoever
 * starts it (the desktop app, launchd, later the one-line installer) as
 * environment variables. The server never asks Electron for these.
 */
export interface ServerConfig {
  /** PI Lab's data folder: database, token, discovery file, daemon socket. */
  dataDir: string
  channel: PiLabChannel
  /** True for a packaged app; source and test runs are false. */
  packaged: boolean
  /** Folder holding bundled resources (latex, skills, whisper). */
  resourcesDir: string
  /** Build identity, used in the hello and to tell when the app and server differ. */
  build: string
  /** App version shown to clients. */
  version: string
  /** Fixed port, or 0 to pick a free one. */
  port: number
}

/** Read a required environment variable or stop with a clear message. */
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`PI Lab server: ${name} is not set`)
  return value
}

/** Parse the server configuration from its environment. */
export function readServerConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const channel = required(env, "PI_LAB_CHANNEL")
  if (channel !== "alpha" && channel !== "beta" && channel !== "stable") {
    throw new Error(`PI Lab server: unknown channel ${channel}`)
  }
  const port = Number(env.PI_LAB_SERVER_PORT ?? "0")
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`PI Lab server: invalid PI_LAB_SERVER_PORT ${env.PI_LAB_SERVER_PORT}`)
  }
  return {
    dataDir: required(env, "PI_LAB_DATA_DIR"),
    channel,
    packaged: env.PI_LAB_PACKAGED === "1",
    resourcesDir: required(env, "PI_LAB_RESOURCES_DIR"),
    build: required(env, "PI_LAB_BUILD"),
    version: required(env, "PI_LAB_VERSION"),
    port,
  }
}

/** The environment variables that carry a {@link ServerConfig}. */
export function serverConfigEnv(config: ServerConfig): Record<string, string> {
  return {
    PI_LAB_CHANNEL: config.channel,
    PI_LAB_DATA_DIR: config.dataDir,
    PI_LAB_PACKAGED: config.packaged ? "1" : "0",
    PI_LAB_RESOURCES_DIR: config.resourcesDir,
    PI_LAB_BUILD: config.build,
    PI_LAB_VERSION: config.version,
    PI_LAB_SERVER_PORT: String(config.port),
  }
}
