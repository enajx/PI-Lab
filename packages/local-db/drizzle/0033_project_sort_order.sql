-- Saved project order for the Dashboard cards and the sidebar. Existing projects keep the
-- order they had (most recently opened first); from now on opening a project does not move it.
ALTER TABLE `projects` ADD `sort_order` integer;--> statement-breakpoint
UPDATE `projects`
SET `sort_order` = (
	SELECT COUNT(*) FROM `projects` AS `other`
	WHERE `other`.`last_opened_at` > `projects`.`last_opened_at`
		OR (`other`.`last_opened_at` = `projects`.`last_opened_at` AND `other`.`id` < `projects`.`id`)
);
