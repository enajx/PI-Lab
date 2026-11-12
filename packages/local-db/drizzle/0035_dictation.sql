CREATE TABLE `dictation_history` (
	`id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`model_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ix_dictation_history_created` ON `dictation_history` (`created_at`);--> statement-breakpoint
CREATE TABLE `dictation_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`selected_model` text,
	`output_action` text DEFAULT 'insert' NOT NULL,
	`waveform_style` text DEFAULT 'dots' NOT NULL,
	`updated_at` integer NOT NULL
);
