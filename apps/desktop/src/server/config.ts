import type { PiLabChannel } from "../main/identity/channel"

/**
 * Everything the server needs to know about its install, passed by whoever
 * starts it (the desktop app, launchd, later the one-line installer) as
 * environment variables. The server never asks Electron for these.
 */
export interface ServerConfig {
  /** PI Lab's data folder: database, token, discovery file, daemon socket. */
  dataDir: string
  /**
   * The desktop app's Electron profile folder. Files the app kept there before
   * the server split stay there: the interface language and the Analysis
   * structure file. Equals `dataDir` for Alpha, Beta and tests.
   */
  profileDir: string
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
  /** Set when the server runs from an install.sh layout (the server bundle); it then updates itself. */
  install: ServerInstall | null
}

/** Where install.sh put this server (see apps/desktop/scripts/server-install/install.sh). */
export interface ServerInstall {
  /** `--prefix`: holds `versions/`, `current`, `previous`, `failed-versions`. */
  prefix: string
  /** This version's folder, `<prefix>/versions/<version>`. */
  root: string
  /** The launchd label it runs under, or null when it was started detached (`--no-launchd`). */
  label: string | null
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
    profileDir: required(env, "PI_LAB_PROFILE_DIR"),
    channel,
    packaged: env.PI_LAB_PACKAGED === "1",
    resourcesDir: required(env, "PI_LAB_RESOURCES_DIR"),
    build: required(env, "PI_LAB_BUILD"),
    version: required(env, "PI_LAB_VERSION"),
    port,
    install: serverInstall(env),
  }
}

/** The install.sh layout from the bundle launcher's environment, or null. */
function serverInstall(env: NodeJS.ProcessEnv): ServerInstall | null {
  const prefix = env.PI_LAB_SERVER_PREFIX?.trim()
  if (!prefix) return null
  return {
    prefix,
    root: required(env, "PI_LAB_SERVER_ROOT"),
    label: env.PI_LAB_SERVER_LABEL?.trim() || null,
  }
}

/** The environment variables that carry a {@link ServerConfig}. */
export function serverConfigEnv(config: ServerConfig): Record<string, string> {
  return {
    PI_LAB_CHANNEL: config.channel,
    PI_LAB_DATA_DIR: config.dataDir,
    PI_LAB_PROFILE_DIR: config.profileDir,
    PI_LAB_PACKAGED: config.packaged ? "1" : "0",
    PI_LAB_RESOURCES_DIR: config.resourcesDir,
    PI_LAB_BUILD: config.build,
    PI_LAB_VERSION: config.version,
    PI_LAB_SERVER_PORT: String(config.port),
  }
}
