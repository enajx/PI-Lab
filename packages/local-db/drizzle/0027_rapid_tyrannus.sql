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
	`keep_running_after_close` integer DEFAULT true NOT NULL,
	`public_update_channel` text DEFAULT 'stable' NOT NULL,
	`worktree_per_agent` integer DEFAULT false NOT NULL,
	`editor` text DEFAULT '{"autosave":false,"vim":false,"diagnosticsEnabled":false,"typeChecker":"ty","formatOnSave":false,"editorTheme":"default","customEditorThemes":[],"pythonRunDestination":"central","latexProvider":"bundled","showHiddenFiles":true,"confirmFileDelete":true}' NOT NULL,
	`notifications` text DEFAULT '{"muted":false,"agentInput":{"enabled":true,"sound":"chime"},"agentTurnCompletion":{"enabled":true,"sound":"success"},"terminalCompletion":{"enabled":true,"sound":"success"},"workflowStart":{"enabled":false,"sound":"pulse"},"workflowCompletion":{"enabled":true,"sound":"success"},"workflowFailure":{"enabled":true,"sound":"alert"}}' NOT NULL,
	`caffeine` text DEFAULT '{"mode":"off","scope":"system-only"}' NOT NULL,
	`project_template` text DEFAULT '{"initializationMarkdownFiles":["AGENTS.md","CLAUDE.md","EXPERIMENT_TRACKING_SQLITE.md","RESEARCH.md","TODO.md"],"defaultTemplateParentPath":null,"projectTypes":[{"id":"general","name":"General project","guidance":"Describe the project goal, scope, current status, and next steps."},{"id":"paper","name":"Paper","guidance":"Describe the paper question, claims, evidence, draft status, and next steps."}]}' NOT NULL,
	`known_teams` text DEFAULT '[]' NOT NULL,
	`zotero` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_settings`("id", "theme", "editor_font_family", "editor_font_size", "terminal_font_family", "terminal_font_size", "agent_presets", "confirm_on_quit", "keep_running_after_close", "public_update_channel", "worktree_per_agent", "editor", "notifications", "caffeine", "project_template", "known_teams", "zotero", "updated_at") SELECT "id", "theme", "editor_font_family", "editor_font_size", "terminal_font_family", "terminal_font_size", "agent_presets", "confirm_on_quit", "keep_running_after_close", "public_update_channel", "worktree_per_agent", "editor", "notifications", "caffeine", "project_template", "known_teams", "zotero", "updated_at" FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `agent_settings` DROP COLUMN `quit_behavior`;