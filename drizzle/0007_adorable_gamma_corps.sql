CREATE TABLE `memories` (
	`key` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`version` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`source_channel` text NOT NULL,
	`source_conversation` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `todos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`details` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`version` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	`source_channel` text NOT NULL,
	`source_conversation` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `todos_status_updated` ON `todos` (`status`,`updated_at`);