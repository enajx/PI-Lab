CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`project_id` text NOT NULL,
	`workspace_id` text,
	`agent_id` text NOT NULL,
	`workflow_run_id` text,
	`state` text DEFAULT 'working' NOT NULL,
	`waiting_reason` text,
	`waiting_since` integer,
	`exited_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `automation_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_sessions_session_id_unique` ON `agent_sessions` (`session_id`);--> statement-breakpoint
CREATE INDEX `ix_agent_sessions_project` ON `agent_sessions` (`project_id`);--> statement-breakpoint
CREATE INDEX `ix_agent_sessions_workspace` ON `agent_sessions` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `ix_agent_sessions_workflow_run` ON `agent_sessions` (`workflow_run_id`);--> statement-breakpoint
CREATE INDEX `ix_agent_sessions_state` ON `agent_sessions` (`state`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`theme` text DEFAULT 'system' NOT NULL,
	`editor_font_family` text,
	`editor_font_size` integer,
	`terminal_font_family` text,
	`terminal_font_size` integer,
	`agent_presets` text DEFAULT '[]' NOT NULL,
	`confirm_on_quit` integer DEFAULT true NOT NULL,
	`worktree_per_agent` integer DEFAULT false NOT NULL,
	`editor` text DEFAULT '{"autosave":false,"vim":false,"typeChecker":"ty","formatOnSave":false,"editorTheme":"default"}' NOT NULL,
	`notifications` text DEFAULT '{"muted":false,"agentInput":{"enabled":true,"sound":"chime"},"workflowStart":{"enabled":false,"sound":"pulse"},"workflowCompletion":{"enabled":true,"sound":"success"},"workflowFailure":{"enabled":true,"sound":"alert"}}' NOT NULL,
	`known_teams` text DEFAULT '[]' NOT NULL,
	`zotero` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_settings`("id", "theme", "editor_font_family", "editor_font_size", "terminal_font_family", "terminal_font_size", "agent_presets", "confirm_on_quit", "worktree_per_agent", "editor", "known_teams", "zotero", "updated_at") SELECT "id", "theme", "editor_font_family", "editor_font_size", "terminal_font_family", "terminal_font_size", "agent_presets", "confirm_on_quit", "worktree_per_agent", "editor", "known_teams", "zotero", "updated_at" FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `completed_at` integer;--> statement-breakpoint
CREATE INDEX `ix_automation_runs_session` ON `automation_runs` (`session_id`);
