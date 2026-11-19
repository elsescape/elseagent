import { Cron } from "croner";
import { isTimezone, MINUTE_MS } from "../util/time.ts";

/** Runs closer together than this are refused, so a bad expression can't flood a channel. */
export const MIN_INTERVAL_MS = 5 * MINUTE_MS;

export class ScheduleError extends Error {
  override name = "ScheduleError";
}

/** Throws ScheduleError unless `timezone` is a valid IANA time zone. */
export function checkTimezone(timezone: string): void {
  if (!isTimezone(timezone)) {
    throw new ScheduleError(`Unknown time zone: ${timezone} (use an IANA name like Asia/Shanghai)`);
  }
}

/**
 * Validate a cron expression and return its next run time (epoch ms) after `from`.
 * Refuses expressions that never fire or fire more often than every MIN_INTERVAL_MS.
 */
export function nextRun(cron: string, timezone: string, from = Date.now()): number {
  checkTimezone(timezone);
  let job: Cron;
  try {
    job = new Cron(cron, { timezone, paused: true });
  } catch (err) {
    throw new ScheduleError(`Invalid cron expression "${cron}": ${(err as Error).message}`);
  }
  const [first, second] = job.nextRuns(2, new Date(from));
  if (!first) throw new ScheduleError(`Cron expression "${cron}" never runs`);
  if (second && second.getTime() - first.getTime() < MIN_INTERVAL_MS) {
    throw new ScheduleError(
      `"${cron}" runs more often than every ${MIN_INTERVAL_MS / MINUTE_MS} minutes; use a longer interval`,
    );
  }
  return first.getTime();
}

/** Human-readable time in the schedule's zone, e.g. "2026-11-15 09:00 (Asia/Shanghai)". */
export function formatTime(epochMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(epochMs));
  return `${parts.replace(",", "")} (${timezone})`;
}
