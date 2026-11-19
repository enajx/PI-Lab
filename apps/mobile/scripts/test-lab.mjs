#!/usr/bin/env node
// Test PI Lab server for the phone app: a separate headless server with its own
// data folder and made-up projects (copies of tests/test-projects), and a
// stand-in agent (scripts/stand-in-agent.sh, labelled as a stand-in: it is not
// a real agent) that prints a question and waits, so the server raises the
// same waiting request a real agent would. Never touches the user's real PI
// Lab data folder or the running PI Lab app's server.
//
// Needs the desktop server bundle: (cd apps/desktop && ./node_modules/.bin/electron-vite build)
//
// Commands (run from the repo root; the folder is $TMPDIR/pi-lab-mobile-test
// unless PI_LAB_MOBILE_TEST_ROOT is set):
//   node apps/mobile/scripts/test-lab.mjs start     start the server on 127.0.0.1:47830, add the
//                                                   projects, create a device token and print the
//                                                   connect link for the emulator (http://10.0.2.2:47830)
//   node apps/mobile/scripts/test-lab.mjs link --address https://mac.example.ts.net
//                                                   a new device token and its connect link for an address
//   node apps/mobile/scripts/test-lab.mjs agent --project python-research --prompt "label"
//                                                   start a stand-in agent; it asks a question at once
//   node apps/mobile/scripts/test-lab.mjs pending   list the pending requests (as the desktop sees them)
//   node apps/mobile/scripts/test-lab.mjs answer --request <id> --text yes
//                                                   answer a request as the desktop would (another device)
//   node apps/mobile/scripts/test-lab.mjs screen --session <id>
//                                                   print a session's screen text (terminal.screenText)
//   node apps/mobile/scripts/test-lab.mjs kill --session <id>
//                                                   end a session (terminal.kill), as when an agent exits
//   node apps/mobile/scripts/test-lab.mjs history   list the finished notices (notification history)
//   node apps/mobile/scripts/test-lab.mjs stop      stop the server and every agent
//
// Emulator: adb reverse is not needed; the emulator reaches the Mac's loopback at 10.0.2.2.

import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, "..", "..", "..")
const DESKTOP = join(REPO, "apps", "desktop")
const SERVER_ENTRY = join(DESKTOP, "out", "main", "server.js")
const STAND_IN = join(HERE, "stand-in-agent.sh")
/** The catalog agent (test mode only) whose executable is replaced by the stand-in. */
const STAND_IN_AGENT_ID = "test-waiting"
const PORT = 47830
const PROJECTS = ["python-research", "software-typescript"]

const ROOT = process.env.PI_LAB_MOBILE_TEST_ROOT || join(tmpdir(), "pi-lab-mobile-test")
const DATA = join(ROOT, "data")

const desktopRequire = createRequire(join(DESKTOP, "package.json"))
const { createTRPCClient, createWSClient, wsLink } = desktopRequire("@trpc/client")

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function discovery() {
  const file = join(DATA, "server.json")
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null
}

/** A tRPC client as the local device ("This Mac"), with the data folder's token. */
function connect() {
  const found = discovery()
  if (!found) throw new Error(`no server runs for ${DATA} (no server.json); run "start" first`)
  const token = readFileSync(join(DATA, "server-token"), "utf8").trim()
  const ws = createWSClient({
    url: `ws://127.0.0.1:${found.port}/trpc?token=${encodeURIComponent(token)}`,
  })
  return { client: createTRPCClient({ links: [wsLink({ client: ws })] }), close: () => ws.close() }
}

async function withClient(run) {
  const { client, close } = connect()
  const result = await run(client)
  close()
  return result
}

function connectLink(address, token) {
  return `pilab://connect?address=${encodeURIComponent(address)}&token=${encodeURIComponent(token)}`
}

async function createDevice(client, name, address) {
  const created = await client.server.devices.create.mutate({ name })
  console.log(`device ${created.device.id} (${name})`)
  console.log(`address: ${address}`)
  console.log(`token:   ${created.token}`)
  console.log(`connect link: ${connectLink(address, created.token)}`)
}

function initRepo(dir) {
  const git = (args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" })
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" })
  git(["config", "user.email", "test@pi-lab.local"])
  git(["config", "user.name", "PI Lab Test"])
  git(["add", "."])
  git(["commit", "-m", "initial"])
}

/**
 * This shell's environment without Claude Code's session markers, so agents
 * the test server starts do not act as children of a Claude Code session.
 * API key variables are kept.
 */
function serverEnvironment() {
  const marker = (name) =>
    name.startsWith("CLAUDE_CODE_") ||
    ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "AI_AGENT"].includes(name)
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !marker(name)))
}

async function start() {
  if (!existsSync(SERVER_ENTRY))
    throw new Error(`no server bundle at ${SERVER_ENTRY}; build it first`)
  if (discovery()) throw new Error(`a server already ran for ${DATA}; run "stop" first`)
  mkdirSync(DATA, { recursive: true })
  const firstStart = !existsSync(join(ROOT, "projects"))
  if (firstStart) {
    for (const name of PROJECTS) {
      const dir = join(ROOT, "projects", name)
      cpSync(join(REPO, "tests", "test-projects", name), dir, { recursive: true })
      // Made-up progress, so the TODO bar shows something: the first task is done.
      const todo = join(dir, "TODO.md")
      writeFileSync(todo, readFileSync(todo, "utf8").replace("- [ ]", "- [x]"))
      initRepo(dir)
    }
  }
  const electron = desktopRequire("electron")
  const log = openSync(join(ROOT, "server.log"), "a")
  const child = spawn(electron, [SERVER_ENTRY], {
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      ...serverEnvironment(),
      ELECTRON_RUN_AS_NODE: "1",
      PI_LAB_TEST_MODE: "1",
      // Test mode mutes notifications unless this is set.
      PI_LAB_TEST_NOTIFICATIONS: "1",
      PI_LAB_CHANNEL: "alpha",
      PI_LAB_DATA_DIR: DATA,
      PI_LAB_PROFILE_DIR: DATA,
      PI_LAB_SOCKET_PATH: join(DATA, "daemon.sock"),
      PI_LAB_PACKAGED: "0",
      PI_LAB_RESOURCES_DIR: join(DESKTOP, "resources"),
      PI_LAB_BUILD: createHash("sha256")
        .update(readFileSync(SERVER_ENTRY))
        .digest("hex")
        .slice(0, 16),
      PI_LAB_VERSION: "0.0.0",
      PI_LAB_SERVER_PORT: String(PORT),
    },
  })
  child.unref()
  for (let waited = 0; !discovery(); waited += 200) {
    if (waited > 60_000)
      throw new Error(`the server did not start; see ${join(ROOT, "server.log")}`)
    await sleep(200)
  }
  console.log(`server pid ${discovery().pid} on 127.0.0.1:${PORT}, data ${DATA}`)
  await withClient(async (client) => {
    const known = await client.projects.list.query()
    for (const name of PROJECTS) {
      const dir = join(ROOT, "projects", name)
      if (!known.some((project) => project.repoPath.endsWith(`/${name}`))) {
        await client.projects.add.mutate({ path: dir })
      }
    }
    await client.settings.updateAgents.mutate({
      defaultAgentId: STAND_IN_AGENT_ID,
      executableOverrides: { [STAND_IN_AGENT_ID]: STAND_IN },
    })
    for (const project of await client.projects.list.query()) {
      console.log(`project "${project.name}" ${project.id}`)
    }
    if (firstStart) await createDevice(client, "Test emulator", `http://10.0.2.2:${PORT}`)
  })
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { values } = parseArgs({
    args: rest,
    options: {
      address: { type: "string" },
      project: { type: "string" },
      prompt: { type: "string" },
      request: { type: "string" },
      session: { type: "string" },
      text: { type: "string" },
    },
    strict: true,
  })
  if (command === "start") return start()
  if (command === "link") {
    if (!values.address) throw new Error("link needs --address")
    return withClient((client) => createDevice(client, "Phone", values.address))
  }
  if (command === "agent") {
    return withClient(async (client) => {
      const project = (await client.projects.list.query()).find(
        (entry) => entry.name === values.project,
      )
      if (!project) throw new Error(`no project named ${values.project}`)
      const started = await client.sessions.start.mutate({
        projectId: project.id,
        agentId: STAND_IN_AGENT_ID,
        origin: "project",
        prompt: values.prompt ?? "stand-in task",
      })
      console.log(`session ${started.sessionId}`)
    })
  }
  if (command === "pending") {
    return withClient(
      (client) =>
        new Promise((resolve) => {
          const seen = []
          const subscription = client.server.onNotification.subscribe(undefined, {
            onData: (message) => {
              if (message.type === "alert" && message.event.kind === "request")
                seen.push(message.event)
            },
          })
          setTimeout(() => {
            subscription.unsubscribe()
            for (const event of seen) {
              console.log(
                `${event.id} session ${event.request.target.sessionId}: ${event.request.body}`,
              )
            }
            if (seen.length === 0) console.log("no pending request")
            resolve()
          }, 1000)
        }),
    )
  }
  if (command === "answer") {
    if (!values.request) throw new Error("answer needs --request")
    return withClient(async (client) => {
      const result = await client.server.answerRequest.mutate({
        requestId: values.request,
        text: values.text ?? "yes",
      })
      console.log(result.status)
    })
  }
  if (command === "screen") {
    if (!values.session) throw new Error("screen needs --session")
    return withClient(async (client) => {
      const screen = await client.terminal.screenText.query({ sessionId: values.session })
      console.log(`${screen.cols}x${screen.rows}\n${screen.text}`)
    })
  }
  if (command === "kill") {
    if (!values.session) throw new Error("kill needs --session")
    return withClient(async (client) => {
      await client.terminal.kill.mutate({ sessionId: values.session })
      console.log(`killed ${values.session}`)
    })
  }
  if (command === "history") {
    return withClient(async (client) => {
      for (const event of await client.server.notificationHistory.query()) {
        console.log(`${event.id} ${event.request.title}: ${event.request.body}`)
      }
    })
  }
  if (command === "stop") {
    const found = discovery()
    if (!found) throw new Error("no server runs")
    await withClient((client) => client.server.stop.mutate({ stopAgents: true }))
    console.log(`stopped server pid ${found.pid}`)
    return
  }
  throw new Error(`unknown command ${command ?? "(none)"}; see the comment at the top of this file`)
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  },
)
