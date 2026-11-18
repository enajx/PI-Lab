import { z } from "zod"

/**
 * Wire schemas of the client API: what the PI Lab server sends to the desktop
 * app and the phone. Plain JSON only (times are epoch milliseconds). This
 * module imports only zod, so any client and any transport can reuse it.
 *
 * Objects the server builds are strict: a field the schema does not list is an
 * error, never dropped. JSON blobs stored in the database (project metadata,
 * gradient, agent config) use plain `z.object`: a key no app version reads
 * (left by an older version) is dropped from the reply instead of failing the
 * whole project list. Their typed fields are still checked.
 */

/** `{ ok: true }`, the result of a call that has nothing else to say. */
export const okSchema = z.strictObject({ ok: z.literal(true) })

/** The view an agent was started from. */
export const agentSessionOriginSchema = z.enum(["project", "latex", "analysis", "tasks", "routine"])

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notificationSoundSchema = z.enum(["chime", "pulse", "success", "alert", "silent"])

export const notificationEventTypeSchema = z.enum([
  "agentInput",
  "agentTurnCompletion",
  "terminalCompletion",
  "workflowStart",
  "workflowCompletion",
  "workflowFailure",
])

/** What a click on a notification opens. */
export const notificationActivationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent"),
    projectId: z.string().min(1),
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
    agentId: z.string().min(1),
    /** The view the agent was started from; a click opens that view. */
    origin: agentSessionOriginSchema,
    label: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("workflow"),
    workflowId: z.string().min(1),
    runId: z.string().min(1),
  }),
  z.object({
    type: z.literal("terminal"),
    projectId: z.string().min(1),
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
    label: z.string().min(1),
  }),
])

export const notificationSoundEventSchema = z.object({ sound: notificationSoundSchema })

export const notificationDeliveryErrorSchema = z.object({ message: z.string().min(1) })

export const notificationRequestSchema = z.strictObject({
  eventType: notificationEventTypeSchema,
  title: z.string(),
  body: z.string(),
  target: notificationActivationSchema,
})

/** One notification the server sent; `at` is epoch ms. */
export const notificationEventSchema = z.strictObject({
  id: z.string(),
  at: z.number(),
  kind: z.enum(["info", "request"]),
  request: notificationRequestSchema,
  sound: notificationSoundSchema,
})

/** A message on a client's notification stream. */
export const notificationStreamMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("alert"), event: notificationEventSchema }),
  z.strictObject({ type: z.literal("cleared"), id: z.string() }),
])

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Optional actions a server can support, listed in its hello. A client hides
 * an action whose capability the connected server does not list.
 * - `devices`: `server.devices.*` (device tokens and revoking them).
 * - `launch-ids`: agent starts accept a `launchId` and never run twice for one.
 * - `answer-request`: `server.answerRequest` (one answer per pending request).
 */
export const SERVER_CAPABILITIES = ["devices", "launch-ids", "answer-request", "machines"] as const

export type ServerCapability = (typeof SERVER_CAPABILITIES)[number]

/**
 * What the server tells a client when it connects. Capabilities stay plain
 * strings, so a list from a newer server still parses.
 */
export const serverHelloSchema = z.strictObject({
  protocol: z.number().int(),
  build: z.string(),
  version: z.string(),
  pid: z.number().int(),
  capabilities: z.array(z.string()),
  /** Stable id of the server's machine (`machine-id` in its data folder). */
  machineId: z.string(),
  hostname: z.string(),
  /** Node's `process.platform` and `process.arch` on the server. */
  platform: z.string(),
  arch: z.string(),
})

/** One device that may connect to the server; `local` is this machine's app. */
export const deviceSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  revokedAt: z.number().nullable(),
  local: z.boolean(),
})

/** A new device and its token, shown once. */
export const createdDeviceSchema = z.strictObject({ device: deviceSchema, token: z.string() })

/** The result of answering a pending request; only the first answer is accepted. */
export const answerRequestResultSchema = z.strictObject({
  status: z.enum(["accepted", "already-answered"]),
})

/** Work that quitting with "stop" would end. */
export const quitWorkSchema = z.strictObject({
  agents: z.number().int(),
  terminals: z.array(z.strictObject({ project: z.string(), command: z.string() })),
  notebooks: z.number().int(),
})

export const notebookCountSchema = z.number().int()

export const backgroundTraySnapshotSchema = z.strictObject({
  projects: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      state: z.enum(["working", "waiting", "idle"]),
    }),
  ),
  updateVersion: z.string().nullable().optional(),
})

/** The project holding a file, or null when no project holds it. */
export const projectFileRouteSchema = z
  .strictObject({ projectId: z.string(), relPath: z.string() })
  .nullable()

/** Settings Electron main keeps a copy of. */
export const appSettingsSchema = z.strictObject({
  keepRunningAfterClose: z.boolean(),
  quitChoice: z.enum(["ask", "background"]),
  editorVim: z.boolean(),
})

/** The public update channel selected in settings. */
export const publicUpdateChannelSchema = z.enum(["stable", "beta"])

/** The data format of the server's database, for the desktop updater. */
export const dataCompatibilitySchema = z.strictObject({
  formatVersion: z.number().int(),
  migrations: z.array(z.strictObject({ hash: z.string(), createdAt: z.number() })),
})

/** Where the server keeps the key its secrets are encrypted with. */
export const secretProtectionSchema = z.enum(["file", "keychain"])

/** A credential row still encrypted by the old app's Electron safeStorage. */
export const legacyCredentialSchema = z.strictObject({
  table: z.enum(["agent", "service"]),
  key: z.string(),
  encryptedValue: z.string(),
})

export const legacyCredentialMoveSchema = z.strictObject({ moved: z.boolean() })

export const pythonRuntimeSchema = z.strictObject({
  source: z
    .enum(["dot-venv", "venv", "uv-project", "poetry", "virtual-env", "conda", "selected"])
    .nullable(),
  displayName: z.string(),
  interpreterPath: z.string().nullable(),
  version: z.string().optional(),
  environmentPath: z.string().optional(),
  runStrategy: z.strictObject({
    kind: z.enum(["environment", "uv-project", "python3", "python", "unavailable"]),
    command: z.string().nullable(),
    argsPrefix: z.array(z.string()),
  }),
})

export const quickPythonOptionsSchema = z.strictObject({
  runtime: pythonRuntimeSchema,
  options: z.array(
    z.strictObject({ path: z.string(), displayName: z.string(), interpreterPath: z.string() }),
  ),
})

export const quickPythonRunSchema = z.strictObject({
  sessionId: z.string(),
  runtime: pythonRuntimeSchema,
})

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const tagColorSchema = z.enum([
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
])

const tableAggFunctionSchema = z.enum([
  "count",
  "nunique",
  "sum",
  "mean",
  "median",
  "min",
  "max",
  "std",
  "sem",
  "first",
  "last",
])

/** How Analysis shows one table file name (stored in project metadata). */
const tableSettingsSchema = z.object({
  view: z.enum(["table", "chart"]),
  spec: z
    .object({
      x: z.string(),
      y: z.array(z.string()),
      splitBy: z.string().nullable(),
      chartType: z.enum(["line", "scatter", "bar"]),
      aggregate: z.enum(["none", "mean", "median", "sum", "count"]),
      band: z.enum(["none", "minmax", "std", "ci95"]),
    })
    .nullable(),
  ops: z.object({
    filters: z.array(
      z.object({
        column: z.string(),
        op: z.enum(["eq", "ne", "lt", "le", "gt", "ge", "contains", "in", "blank", "notBlank"]),
        value: z.string(),
        values: z.array(z.string()),
      }),
    ),
    aggregation: z
      .discriminatedUnion("kind", [
        z.object({
          kind: z.literal("groupBy"),
          by: z.array(z.string()),
          values: z.array(z.object({ column: z.string(), fn: tableAggFunctionSchema })),
        }),
        z.object({
          kind: z.literal("pivot"),
          index: z.string(),
          columns: z.string(),
          values: z.string(),
          fn: tableAggFunctionSchema,
        }),
        z.object({ kind: z.literal("describe") }),
        z.object({ kind: z.literal("valueCounts"), columns: z.array(z.string()) }),
      ])
      .nullable(),
    sort: z.array(z.object({ column: z.string(), descending: z.boolean() })),
  }),
  display: z.object({
    hidden: z.array(z.string()),
    order: z.array(z.string()),
    decimals: z.number().nullable(),
    scientific: z.boolean(),
  }),
  chartColors: z.string().nullable().optional(),
})

/** User-entered project metadata, stored as one JSON blob. */
export const projectMetadataSchema = z.object({
  textTags: z.array(z.object({ label: z.string(), color: tagColorSchema })).optional(),
  collaborators: z.string().optional(),
  venue: z.string().optional(),
  deadline: z.string().optional(),
  emojiTags: z.array(z.string()).optional(),
  referenceLinks: z.array(z.object({ url: z.string(), label: z.string().optional() })).optional(),
  paper: z
    .object({
      dir: z.string(),
      remoteUrl: z.string().nullable(),
      lastSyncAt: z.number().nullable(),
      outputDir: z.string().optional(),
      mainDoc: z.string().optional(),
      syncEnabled: z.boolean().optional(),
    })
    .optional(),
  paperOnly: z.literal(true).optional(),
  paperAutoDetect: z.boolean().optional(),
  stage: z.enum(["planning", "experiments", "paperWriting", "submitted"]).optional(),
  resultsFolder: z.string().optional(),
  analysisFormat: z.enum(["md", "qmd", "myst", "html", "marimo", "ipynb"]).optional(),
  tableSettings: z.record(z.string(), tableSettingsSchema).optional(),
})

/** A project row as the server returns it; times are epoch ms. */
export const projectSchema = z.strictObject({
  id: z.string(),
  repoPath: z.string(),
  name: z.string(),
  defaultBranch: z.string().nullable(),
  color: z.string().nullable(),
  /** The card image as a `data:` URL, or null. */
  thumbnail: z.string().nullable(),
  gradient: z.object({ seed: z.number(), palette: z.array(z.string()) }).nullable(),
  digitalRain: z.boolean(),
  metadata: projectMetadataSchema.nullable(),
  taskRelPath: z.string().nullable(),
  mainRelPath: z.string().nullable(),
  typeId: z.string(),
  agentConfig: z.object({ agentId: z.string().nullable().optional() }).nullable(),
  sortIndex: z.number(),
  sortOrder: z.number().nullable(),
  archivedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastOpenedAt: z.number(),
})

/** One `projects.list` entry: the project without its image, and whether it has one. */
export const projectSummarySchema = projectSchema
  .omit({ thumbnail: true })
  .extend({ hasThumbnail: z.boolean() })

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Live state of one agent, for project indicators and the title bar. */
export const liveAgentStatusSchema = z.strictObject({
  sessionId: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  agentId: z.string(),
  workspaceId: z.string().nullable(),
  origin: agentSessionOriginSchema,
  state: z.enum(["working", "waiting"]),
})

const projectAgentStatusSchema = z.enum(["working", "waiting", "done", "failed"])

/** One row of a project's "Project Agents" box; `lastActiveAt` is epoch ms. */
export const projectAgentRowSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("agent"),
    sessionId: z.string(),
    agentId: z.string(),
    workspaceId: z.string().nullable(),
    origin: z.enum(["latex", "analysis", "tasks", "routine"]),
    name: z.string(),
    status: projectAgentStatusSchema,
    lastActiveAt: z.number(),
  }),
  z.strictObject({
    kind: z.literal("background"),
    task: z.enum(["summary", "fetch-experiments", "plan-research", "latex-merge"]),
    status: projectAgentStatusSchema,
    lastActiveAt: z.number(),
  }),
])

/** The result of starting an agent. */
export const startSessionResultSchema = z.strictObject({
  sessionId: z.string(),
  workspaceId: z.string(),
  kind: z.enum(["branch", "worktree"]),
  /** Shown to the user after a start that worked with a limit; null when there is none. */
  warning: z.string().nullable(),
})

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

const executionModeSchema = z.enum(["interactive", "noninteractive"])

/** One automation in the list; times are epoch ms. */
export const automationListItemSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  agentId: z.string(),
  executionMode: executionModeSchema,
  projectId: z.string(),
  recurrenceRule: z.string(),
  scheduleSummary: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
  nextRunAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export const automationDetailSchema = automationListItemSchema.extend({
  prompt: z.string(),
  startAt: z.number(),
})

/** One firing of an automation; times are epoch ms. */
export const automationRunSchema = z.strictObject({
  id: z.string(),
  automationId: z.string(),
  scheduledFor: z.number(),
  state: z.enum(["pending", "launched", "running", "completed", "failed"]),
  workspaceId: z.string().nullable(),
  sessionId: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
  launchedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
})

export const automationPromptVersionSchema = z.strictObject({
  id: z.string(),
  automationId: z.string(),
  prompt: z.string(),
  origin: z.enum(["edit", "revert"]),
  createdAt: z.number(),
})

export const automationRunNowSchema = z.strictObject({ runId: z.string().nullable() })

/** A schedule preview; `upcoming` holds epoch ms. */
export const schedulePreviewSchema = z.strictObject({
  valid: z.boolean(),
  summary: z.string(),
  upcoming: z.array(z.number()),
})

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** A file's fingerprint (`mtimeMs` is epoch ms); `exists: false` has zero fields. */
export const fileStatSchema = z.strictObject({
  exists: z.boolean(),
  mtimeMs: z.number(),
  size: z.number().int(),
})

/**
 * `files.write`: `saved` with the written fingerprint, or `conflict` when the
 * file on disk is no longer the version the client opened (nothing written).
 */
export const fileWriteResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("saved"),
    bytes: z.number().int(),
    baseline: fileStatSchema,
    matchesWrittenContent: z.boolean(),
  }),
  z.strictObject({ status: z.literal("conflict"), baseline: fileStatSchema }),
])
