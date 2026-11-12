-- Only Move to background can be remembered on quit (the user's decision): a saved
-- "quit" choice goes back to asking every time.
UPDATE `settings` SET `quit_choice` = 'ask' WHERE `quit_choice` = 'quit';
