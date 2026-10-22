ALTER TABLE `agent_settings` ADD `launch_defaults` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_settings` ADD `default_agent_id` text;
