import { type ChildProcess, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { readServerDiscovery } from "./serverClient"

/**
 * The environment a headless PI Lab server needs in test mode: the server
 * configuration the desktop app would pass, a temp data folder and the
 * deterministic test agents.
 */
export function headlessServerEnv(options: {
  dataDir: string
  resourcesDir: string
  serverEntry: string
}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SHELL: "/bin/zsh",
    PI_LAB_TEST_MODE: "1",
    PI_LAB_CHANNEL: "alpha",
    PI_LAB_DATA_DIR: options.dataDir,
    PI_LAB_PROFILE_DIR: options.dataDir,
    PI_LAB_SOCKET_PATH: join(options.dataDir, "daemon.sock"),
    PI_LAB_PACKAGED: "0",
    PI_LAB_RESOURCES_DIR: options.resourcesDir,
    PI_LAB_BUILD: createHash("sha256")
      .update(readFileSync(options.serverEntry))
      .digest("hex")
      .slice(0, 16),
    PI_LAB_VERSION: "0.0.0",
  }
}

/**
 * Start a headless server with `command args` and wait until it listens
 * (its `server.json` names a live pid). Server output goes to this test's
 * output, so a failed start shows why.
 */
export async function startHeadlessServer(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  dataDir: string,
): Promise<ChildProcess> {
  const child = spawn(command, args, { env, stdio: ["ignore", "inherit", "inherit"] })
  const deadline = Date.now() + 60_000
  while (readServerDiscovery(dataDir) === null) {
    if (child.exitCode !== null) throw new Error(`The server exited with ${child.exitCode}`)
    if (Date.now() > deadline) throw new Error("The server did not listen within 60 s")
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return child
}
