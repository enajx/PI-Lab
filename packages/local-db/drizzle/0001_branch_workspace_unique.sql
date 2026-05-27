-- Custom SQL migration file, put your code below! --

-- Enforce "at most one branch-kind workspace per project".
-- Drizzle's schema DSL cannot express a partial (filtered) index, so this is
-- authored as a custom migration. drizzle-kit created this file and its journal
-- entry via `generate --custom`; only the SQL body below is hand-written.
CREATE UNIQUE INDEX `ux_one_branch_workspace_per_project`
  ON `workspaces` (`project_id`)
  WHERE `kind` = 'branch';
