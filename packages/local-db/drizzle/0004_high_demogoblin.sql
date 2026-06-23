CREATE TABLE `machines` (
	`id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`hostname` text,
	`user` text,
	`port` integer,
	`source` text DEFAULT 'manual' NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`label` text,
	`reachable` integer,
	`last_checked_at` integer,
	`status_detail` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machines_host_unique` ON `machines` (`host`);--> statement-breakpoint
CREATE INDEX `ix_machines_hidden` ON `machines` (`hidden`);--> statement-breakpoint
CREATE INDEX `ix_machines_source` ON `machines` (`source`);