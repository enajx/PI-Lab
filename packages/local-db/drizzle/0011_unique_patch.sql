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
	`editor` text DEFAULT '{"autosave":false,"vim":false,"diagnosticsEnabled":false,"typeChecker":"ty","formatOnSave":false,"editorTheme":"default"}' NOT NULL,
	`notifications` text DEFAULT '{"muted":false,"agentInput":{"enabled":true,"sound":"chime"},"agentTurnCompletion":{"enabled":true,"sound":"success"},"terminalCompletion":{"enabled":true,"sound":"success"},"workflowStart":{"enabled":false,"sound":"pulse"},"workflowCompletion":{"enabled":true,"sound":"success"},"workflowFailure":{"enabled":true,"sound":"alert"}}' NOT NULL,
	`caffeine` text DEFAULT '{"mode":"off","scope":"system-only"}' NOT NULL,
	`known_teams` text DEFAULT '[]' NOT NULL,
	`zotero` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_settings`("id", "theme", "editor_font_family", "editor_font_size", "terminal_font_family", "terminal_font_size", "agent_presets", "confirm_on_quit", "worktree_per_agent", "editor", "notifications", "caffeine", "known_teams", "zotero", "updated_at") SELECT "id", "theme", "editor_font_family", "editor_font_size", "terminal_font_family", "terminal_font_size", "agent_presets", "confirm_on_quit", "worktree_per_agent", "editor", "notifications", "caffeine", "known_teams", "zotero", "updated_at" FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `turn_armed` integer DEFAULT false NOT NULL;