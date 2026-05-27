CREATE TABLE `automation_prompt_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`automation_id` text NOT NULL,
	`prompt` text NOT NULL,
	`origin` text DEFAULT 'edit' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_prompt_versions_automation` ON `automation_prompt_versions` (`automation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`automation_id` text NOT NULL,
	`scheduled_for` integer NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`workspace_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	`launched_at` integer,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_automation_runs_automation` ON `automation_runs` (`automation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ix_automation_runs_workspace` ON `automation_runs` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`agent_id` text NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`recurrence_rule` text NOT NULL,
	`start_at` integer NOT NULL,
	`timezone` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_automations_project` ON `automations` (`project_id`);--> statement-breakpoint
CREATE INDEX `ix_automations_due` ON `automations` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `browser_history` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`visit_count` integer DEFAULT 1 NOT NULL,
	`visited_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `browser_history_url_unique` ON `browser_history` (`url`);--> statement-breakpoint
CREATE INDEX `ix_browser_history_visited` ON `browser_history` (`visited_at`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_path` text NOT NULL,
	`name` text NOT NULL,
	`default_branch` text,
	`color` text,
	`sort_index` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_opened_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_repo_path_unique` ON `projects` (`repo_path`);--> statement-breakpoint
CREATE INDEX `ix_projects_sort` ON `projects` (`sort_index`);--> statement-breakpoint
CREATE INDEX `ix_projects_last_opened` ON `projects` (`last_opened_at`);--> statement-breakpoint
CREATE INDEX `ix_projects_archived` ON `projects` (`archived_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`theme` text DEFAULT 'system' NOT NULL,
	`editor_font_family` text,
	`editor_font_size` integer,
	`terminal_font_family` text,
	`terminal_font_size` integer,
	`agent_presets` text DEFAULT '[]' NOT NULL,
	`confirm_on_quit` integer DEFAULT true NOT NULL,
	`known_teams` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_sections` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`sort_index` integer DEFAULT 0 NOT NULL,
	`collapsed` integer DEFAULT false NOT NULL,
	`color` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ix_workspace_sections_project` ON `workspace_sections` (`project_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`worktree_id` text,
	`section_id` text,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`branch` text NOT NULL,
	`port_base` integer,
	`sort_index` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_active_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`section_id`) REFERENCES `workspace_sections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_workspaces_project` ON `workspaces` (`project_id`);--> statement-breakpoint
CREATE INDEX `ix_workspaces_worktree` ON `workspaces` (`worktree_id`);--> statement-breakpoint
CREATE INDEX `ix_workspaces_section` ON `workspaces` (`section_id`);--> statement-breakpoint
CREATE INDEX `ix_workspaces_last_active` ON `workspaces` (`last_active_at`);--> statement-breakpoint
CREATE TABLE `worktrees` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`branch` text NOT NULL,
	`base_branch` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_path_unique` ON `worktrees` (`path`);--> statement-breakpoint
CREATE INDEX `ix_worktrees_project` ON `worktrees` (`project_id`);--> statement-breakpoint
CREATE INDEX `ix_worktrees_branch` ON `worktrees` (`branch`);