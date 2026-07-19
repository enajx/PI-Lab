CREATE TABLE `agent_credentials` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`encrypted_value` text NOT NULL,
	`updated_at` integer NOT NULL
);
