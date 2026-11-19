import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type {
  AnyProcedure,
  AnySubscriptionProcedure,
  inferProcedureInput,
  inferProcedureOutput,
  inferSubscriptionOutput,
} from "@trpc/server"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { z } from "zod"
import type { ServerRouter } from "../main/trpc/serverRouter"
import { createHarness, type Harness, LONG_FAKE_AGENT } from "../main/trpc/testHarness"
import { showErrorStacks } from "../main/trpc/trpc"
import {
  automationDetailSchema,
  automationListItemSchema,
  automationPromptVersionSchema,
  automationRunSchema,
  liveAgentStatusSchema,
  notificationActivationSchema,
  projectAgentRowSchema,
  projectSchema,
  projectSummarySchema,
  schedulePreviewSchema,
  startSessionResultSchema,
} from "../shared/clientApi"

// ---------------------------------------------------------------------------
// Type-level guard: every input, result and event the server serves is plain
// JSON. A procedure that returns a Date, Map, Set, bigint, bytes, a function,
// an `undefined` inside an array, `any` or `unknown` makes `tsc` fail here
// and names the procedure path and field.
// ---------------------------------------------------------------------------

type Depth = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

/** The paths inside `T` that JSON does not carry unchanged, as readable strings. */
type NonJson<T, P extends string, D extends number> = [D] extends [never]
  ? never
  : 0 extends 1 & T
    ? `${P}: any`
    : unknown extends T
      ? `${P}: unknown`
      : T extends string | number | boolean | null | undefined | void
        ? never
        : T extends bigint
          ? `${P}: bigint`
          : T extends Date
            ? `${P}: Date`
            : T extends Map<unknown, unknown>
              ? `${P}: Map`
              : T extends Set<unknown>
                ? `${P}: Set`
                : T extends RegExp | Error | Promise<unknown> | symbol
                  ? `${P}: not JSON`
                  : T extends ArrayBuffer | ArrayBufferView
                    ? `${P}: bytes`
                    : T extends (...args: never[]) => unknown
                      ? `${P}: function`
                      : T extends readonly (infer E)[]
                        ?
                            | (undefined extends E ? `${P}[]: undefined in array` : never)
                            | NonJson<E, `${P}[]`, Depth[D]>
                        : {
                            [K in keyof T & string]-?: NonJson<T[K], `${P}.${K}`, Depth[D]>
                          }[keyof T & string]

/** Every non-JSON path of every procedure in a router record. */
type NonJsonProcedures<R, P extends string> = {
  [K in keyof R & string]: R[K] extends AnyProcedure
    ?
        | NonJson<inferProcedureInput<R[K]>, `${P}${K} input`, 10>
        | (R[K] extends AnySubscriptionProcedure
            ? NonJson<inferSubscriptionOutput<R[K]>, `${P}${K} event`, 10>
            : NonJson<Awaited<inferProcedureOutput<R[K]>>, `${P}${K} result`, 10>)
    : NonJsonProcedures<R[K], `${P}${K}.`>
}[keyof R & string]

type ServerNonJson = NonJsonProcedures<ServerRouter["_def"]["record"], "">
const serverIsPlainJson: [ServerNonJson] extends [never] ? true : ServerNonJson = true

test("every server procedure has plain JSON inputs, results and events (checked by tsc)", () => {
  expect(serverIsPlainJson).toBe(true)
})

// ---------------------------------------------------------------------------
// No SuperJSON on the client API.
// ---------------------------------------------------------------------------

const desktopDir = join(import.meta.dirname, "..", "..")

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

test("neither the server, Electron main, the renderer nor the test client imports superjson", () => {
  const files = [
    ...sourceFiles(join(desktopDir, "src")),
    ...sourceFiles(join(desktopDir, "..", "..", "tests", "e2e")),
  ]
  const pattern = new RegExp(`from "${"superjson"}"|require\\("${"superjson"}"\\)`)
  const importers = files.filter((file) => pattern.test(readFileSync(file, "utf8")))
  expect(importers).toEqual([])
})

test("error stack traces reach clients only in test mode or development", () => {
  expect(showErrorStacks({ PI_LAB_TEST_MODE: "1" })).toBe(true)
  expect(showErrorStacks({ NODE_ENV: "development" })).toBe(true)
  expect(showErrorStacks({ NODE_ENV: "production" })).toBe(false)
  expect(showErrorStacks({ NODE_ENV: "test" })).toBe(false)
  expect(showErrorStacks({})).toBe(false)
})

// ---------------------------------------------------------------------------
// Runtime: real results through the real routers survive JSON unchanged and
// match the client API schemas.
// ---------------------------------------------------------------------------

/** The value a JSON client receives: what survives JSON.stringify/parse. */
function expectPlainJson(value: unknown): void {
  expect(JSON.parse(JSON.stringify(value))).toEqual(value)
}

/** Parse with the client API schema and check the result is plain JSON. */
function expectWire<T>(schema: z.ZodType<T>, value: unknown): void {
  expect(schema.parse(value)).toEqual(value)
  expectPlainJson(value)
}

let h: Harness

beforeEach(async () => {
  h = await createHarness([LONG_FAKE_AGENT])
})

afterEach(async () => {
  await h.dispose()
})

test("projects, sessions and automations results and events match the client API", async () => {
  const project = await h.caller.projects.add({ path: h.repoDir })
  expectWire(projectSchema, project)
  await h.caller.projects.setMetadata({
    id: project.id,
    metadata: { venue: "A venue", textTags: [{ label: "tag", color: "blue" }] },
  })
  expectWire(projectSchema, await h.caller.projects.get({ id: project.id }))
  expectWire(z.array(projectSummarySchema), await h.caller.projects.list())

  const statuses: unknown[] = []
  const stream = await h.caller.sessions.onStatus()
  const subscription = stream.subscribe({ next: (event) => statuses.push(event) })
  const started = await h.caller.sessions.start({
    origin: "routine",
    projectId: project.id,
    agentId: LONG_FAKE_AGENT.id,
  })
  expectWire(startSessionResultSchema, started)
  await vi.waitFor(() => expect(statuses.some((event) => (event as []).length > 0)).toBe(true))
  subscription.unsubscribe()
  for (const event of statuses) expectWire(z.array(liveAgentStatusSchema), event)
  await vi.waitFor(async () =>
    expect(await h.caller.sessions.projectAgents({ projectId: project.id })).not.toEqual([]),
  )
  expectWire(
    z.array(projectAgentRowSchema),
    await h.caller.sessions.projectAgents({ projectId: project.id }),
  )

  const automation = await h.caller.automations.create({
    projectId: project.id,
    agentId: LONG_FAKE_AGENT.id,
    name: "Nightly",
    prompt: "Run the nightly check",
    recurrenceRule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
    timezone: "UTC",
  })
  expectWire(automationDetailSchema, automation)
  expectWire(automationDetailSchema, await h.caller.automations.get({ id: automation.id }))
  expectWire(z.array(automationListItemSchema), await h.caller.automations.list())
  expectWire(
    schedulePreviewSchema,
    await h.caller.automations.previewSchedule({
      recurrenceRule: "FREQ=DAILY",
      timezone: "UTC",
    }),
  )
  await h.caller.automations.runNow({ id: automation.id })
  const runs = await h.caller.automations.listRuns({ automationId: automation.id })
  expect(runs).not.toEqual([])
  expectWire(z.array(automationRunSchema), runs)
  expectWire(
    z.array(automationPromptVersionSchema),
    await h.caller.automations.listPromptVersions({ automationId: automation.id }),
  )
})

test("notification activation events match the client API", async () => {
  const received: unknown[] = []
  const stream = await h.caller.notifications.onActivation()
  const subscription = stream.subscribe({ next: (event) => received.push(event) })
  h.notifications.activations.publish({ type: "workflow", workflowId: "w", runId: "r" })
  subscription.unsubscribe()
  expect(received).toHaveLength(1)
  for (const event of received) expectWire(notificationActivationSchema, event)
})

test("results of other namespaces survive JSON unchanged", async () => {
  const project = await h.caller.projects.add({ path: h.repoDir })
  const workspace = await h.caller.workspaces.ensureMain({ projectId: project.id })
  writeFileSync(join(h.repoDir, "notes.md"), "# Notes\n")
  for (const result of [
    await h.caller.health.ping(),
    await h.caller.settings.get(),
    await h.caller.workspaces.list({ projectId: project.id }),
    await h.caller.agents.list(),
    await h.caller.caffeine.status(),
    await h.caller.setup.harnesses(),
    await h.caller.files.stat({ workspaceId: workspace.id, relPath: "notes.md" }),
  ])
    expectPlainJson(result)
})
