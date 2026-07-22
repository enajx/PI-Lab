CREATE TABLE `project_workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`task` text NOT NULL,
	`result` text DEFAULT '' NOT NULL,
	`input_hash` text DEFAULT '' NOT NULL,
	`last_checked_at` integer NOT NULL,
	`error_message` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_project_workflow_runs_project_task` ON `project_workflow_runs` (`project_id`,`task`);--> statement-breakpoint
CREATE INDEX `ix_project_workflow_runs_project` ON `project_workflow_runs` (`project_id`);