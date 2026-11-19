import type { UsageRecord } from "../state/index.ts";
import { DAY_MS } from "../util/time.ts";
import { formatTime } from "./cron.ts";

export const USAGE_GROUPS = ["day", "user", "channel", "conversation", "schedule"] as const;
export type UsageGroup = (typeof USAGE_GROUPS)[number];

/** At most this many groups are listed (the largest ones; days are all listed up to this). */
export const MAX_USAGE_GROUPS = 60;

export class UsagePeriodError extends Error {
  override name = "UsagePeriodError";
}

/** The calendar day of an instant in a time zone, as YYYY-MM-DD. */
export function dayIn(epochMs: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(epochMs));
}

/** How far a time zone is ahead of UTC at an instant, in ms. */
function offsetMs(epochMs: number, timezone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    })
      .formatToParts(new Date(epochMs))
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** Midnight at the start of a YYYY-MM-DD day in a time zone, as epoch ms. */
export function startOfDay(day: string, timezone: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const utcMidnight = Date.UTC(y, m - 1, d);
  // The offset at the guess may differ from the one at the real instant (DST): look twice.
  const guess = utcMidnight - offsetMs(utcMidnight, timezone);
  return utcMidnight - offsetMs(guess, timezone);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The period a usage report covers, [from, to). `since` and `until` are dates (whole days in
 * `timezone`; `until` included) or ISO date-times; without them, the last `days` days (default
 * 7) up to now.
 */
export function usagePeriod(
  input: { since?: string; until?: string; days?: number },
  timezone: string,
  now: number,
): { from: number; to: number } {
  const parse = (value: string, end: boolean) => {
    if (DATE_ONLY.test(value)) {
      const start = startOfDay(value, timezone);
      if (Number.isNaN(start)) throw new UsagePeriodError(`Invalid date: ${value}`);
      return end ? startOfDay(dayIn(start + DAY_MS + DAY_MS / 2, timezone), timezone) : start;
    }
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) {
      throw new UsagePeriodError(`Invalid date or time: ${value} (use YYYY-MM-DD or ISO 8601)`);
    }
    return ms;
  };
  const to = input.until ? parse(input.until, true) : now;
  const from = input.since ? parse(input.since, false) : to - (input.days ?? 7) * DAY_MS;
  if (from >= to) throw new UsagePeriodError("The period is empty: since must be before until.");
  return { from, to };
}

interface Totals {
  turns: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

const empty = (): Totals => ({
  turns: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
});

function add(t: Totals, r: UsageRecord): void {
  t.turns++;
  t.inputTokens += r.inputTokens;
  t.cachedInputTokens += r.cachedInputTokens;
  t.outputTokens += r.outputTokens;
  t.reasoningOutputTokens += r.reasoningOutputTokens;
  t.totalTokens += r.inputTokens + r.outputTokens;
}

const groupKey = (r: UsageRecord, by: UsageGroup, timezone: string): string => {
  switch (by) {
    case "day":
      return dayIn(r.at, timezone);
    case "user":
      return r.scheduleId !== null ? `schedule #${r.scheduleId}` : r.user;
    case "channel":
      return r.channel;
    case "conversation":
      return r.conversationKey;
    case "schedule":
      return r.scheduleId !== null ? `#${r.scheduleId}` : "(not scheduled)";
  }
};

/**
 * Token totals over a period, optionally broken down. Input tokens include cached ones;
 * output tokens include reasoning.
 */
export function summarizeUsage(
  rows: UsageRecord[],
  period: { from: number; to: number },
  timezone: string,
  groupBy?: UsageGroup,
) {
  const total = empty();
  let durationMs = 0;
  const groups = new Map<string, Totals>();
  for (const r of rows) {
    add(total, r);
    durationMs += r.durationMs;
    if (!groupBy) continue;
    const key = groupKey(r, groupBy, timezone);
    const g = groups.get(key) ?? empty();
    add(g, r);
    groups.set(key, g);
  }
  const sorted = [...groups.entries()];
  if (groupBy === "day") sorted.sort(([a], [b]) => a.localeCompare(b));
  else sorted.sort(([, a], [, b]) => b.totalTokens - a.totalTokens);
  const listed = sorted.map(([key, t]) => ({ [groupBy ?? "key"]: key, ...t }));
  return {
    from: formatTime(period.from, timezone),
    to: formatTime(period.to, timezone),
    ...total,
    averageTurnSeconds: total.turns ? Math.round(durationMs / total.turns / 1000) : 0,
    ...(groupBy
      ? {
          groupBy,
          groups: listed.slice(0, MAX_USAGE_GROUPS),
          ...(listed.length > MAX_USAGE_GROUPS
            ? { groupsOmitted: listed.length - MAX_USAGE_GROUPS }
            : {}),
        }
      : {}),
  };
}
