import { relations } from "drizzle-orm"
import {
  automationPromptVersions,
  automationRuns,
  automations,
  projects,
  workspaceSections,
  workspaces,
  worktrees,
} from "./tables"

// Drizzle relation graph for the query builder (`db.query.*.with`). These mirror
// the foreign keys declared in `tables.ts`; they add no SQL of their own.

export const projectRelations = relations(projects, ({ many }) => ({
  worktrees: many(worktrees),
  workspaces: many(workspaces),
  sections: many(workspaceSections),
  automations: many(automations),
}))

export const worktreeRelations = relations(worktrees, ({ one, many }) => ({
  project: one(projects, {
    fields: [worktrees.projectId],
    references: [projects.id],
  }),
  workspaces: many(workspaces),
}))

export const workspaceSectionRelations = relations(workspaceSections, ({ one, many }) => ({
  project: one(projects, {
    fields: [workspaceSections.projectId],
    references: [projects.id],
  }),
  workspaces: many(workspaces),
}))

export const workspaceRelations = relations(workspaces, ({ one, many }) => ({
  project: one(projects, {
    fields: [workspaces.projectId],
    references: [projects.id],
  }),
  worktree: one(worktrees, {
    fields: [workspaces.worktreeId],
    references: [worktrees.id],
  }),
  section: one(workspaceSections, {
    fields: [workspaces.sectionId],
    references: [workspaceSections.id],
  }),
  automationRuns: many(automationRuns),
}))

export const automationRelations = relations(automations, ({ one, many }) => ({
  project: one(projects, {
    fields: [automations.projectId],
    references: [projects.id],
  }),
  runs: many(automationRuns),
  promptVersions: many(automationPromptVersions),
}))

export const automationRunRelations = relations(automationRuns, ({ one }) => ({
  automation: one(automations, {
    fields: [automationRuns.automationId],
    references: [automations.id],
  }),
  workspace: one(workspaces, {
    fields: [automationRuns.workspaceId],
    references: [workspaces.id],
  }),
}))

export const automationPromptVersionRelations = relations(automationPromptVersions, ({ one }) => ({
  automation: one(automations, {
    fields: [automationPromptVersions.automationId],
    references: [automations.id],
  }),
}))
