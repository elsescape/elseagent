PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`cron` text,
	`timezone` text NOT NULL,
	`channel` text NOT NULL,
	`prompt` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_skipped_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_schedules`("id", "name", "cron", "timezone", "channel", "prompt", "created_by", "created_at", "next_run_at", "last_run_at", "last_skipped_at") SELECT "id", "name", "cron", "timezone", "channel", "prompt", "created_by", "created_at", "next_run_at", "last_run_at", NULL FROM `schedules`;--> statement-breakpoint
UPDATE sqlite_sequence
SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'schedules'), 0))
WHERE name = '__new_schedules';--> statement-breakpoint
INSERT INTO sqlite_sequence(name, seq)
SELECT '__new_schedules', seq FROM sqlite_sequence WHERE name = 'schedules'
AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = '__new_schedules');--> statement-breakpoint
DROP TABLE `schedules`;--> statement-breakpoint
ALTER TABLE `__new_schedules` RENAME TO `schedules`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `schedules_next_run` ON `schedules` (`next_run_at`);