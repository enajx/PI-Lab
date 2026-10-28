-- Add the global compiler choice without replacing any saved editor or app preferences.
UPDATE `settings`
SET `editor` = json_set(`editor`, '$.latexProvider', 'bundled')
WHERE json_type(`editor`, '$.latexProvider') IS NULL;
