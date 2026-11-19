import { z } from "zod";
import type { NewQueuedMessage, Schedule, ScheduleStore } from "../state/index.ts";
import { checkTimezone, formatTime, nextRun, ScheduleError } from "./cron.ts";
import type { Scheduler } from "./scheduler.ts";

/** At most this many schedules per agent. */
export const MAX_SCHEDULES = 50;
const oneTimeDate = z.iso
  .datetime({ offset: true })
  .or(z.iso.datetime({ offset: true, precision: -1 }));

export interface CreateScheduleInput {
  name: string;
  cron?: string;
  at?: string;
  timezone: string;
  /** Channel ID the agent can already post in (Slack ID, or `tg:<chat id>`). */
  channel: string;
  prompt: string;
  createdBy: string;
}

/** What Codex is told on a scheduled run. Its first line is read back by `scheduledTaskName`. */
export function scheduledTaskInput(schedule: Schedule, at: number): string {
  return [
    `Scheduled task "${schedule.name}" (#${schedule.id}, created by <@${schedule.createdBy}>),`,
    `running at ${formatTime(at, schedule.timezone)}. Your reply is posted as a new message`,
    "(in Telegram, a new topic); people may follow up in its thread. The task name is added",
    "automatically. For a long result, begin with a short summary paragraph (at most 400",
    "characters); the full result is posted in the thread below it. When the task is a",
    "check and there is nothing to report, return reply: false to post nothing. For example,",
    "for an error-only alert, stay silent when the check succeeds and finds no errors.",
    "You can also return reply: false if the user asked for delivery only to specific",
    "destinations and all those separate deliveries succeeded. Otherwise report any",
    "delivery failure and provide the report if requested. Task:",
    "",
    schedule.prompt,
  ].join("\n");
}

/** The schedule name in a scheduled run's input (see `scheduledTaskInput`), if it has one. */
export function scheduledTaskName(input: string): string | undefined {
  return input.match(/^Scheduled task "(.*)" \(#\d+/)?.[1];
}

/** Creates schedules and queues their runs when they are due. */
export class ScheduleRunner {
  constructor(
    private readonly store: ScheduleStore,
    private readonly scheduler: Pick<Scheduler, "submit" | "enqueue" | "pump">,
    private readonly now: () => number = Date.now,
  ) {}

  create(input: CreateScheduleInput): Schedule {
    if (this.store.count() >= MAX_SCHEDULES) {
      throw new ScheduleError(
        `This agent already has ${MAX_SCHEDULES} schedules; delete some first`,
      );
    }
    const { at, cron, ...schedule } = input;
    if ((at === undefined) === (cron === undefined)) {
      throw new ScheduleError("Provide exactly one of cron or at.");
    }
    const now = this.now();
    checkTimezone(schedule.timezone);
    let nextRunAt: number;
    if (at !== undefined) {
      if (!oneTimeDate.safeParse(at).success) {
        throw new ScheduleError("at must be an ISO 8601 date-time with a UTC offset or Z.");
      }
      nextRunAt = Date.parse(at);
      if (!Number.isFinite(nextRunAt) || nextRunAt <= now) {
        throw new ScheduleError("at must be in the future.");
      }
    } else {
      nextRunAt = nextRun(cron ?? "", schedule.timezone, now);
    }
    return this.store.create({ ...schedule, cron, nextRunAt });
  }

  /** Queue a manual run without changing the automatic schedule. */
  runNow(schedule: Schedule): boolean {
    return (
      this.scheduler.submit(this.message(schedule, `manual:${crypto.randomUUID()}`, this.now()))
        .status !== "rejected"
    );
  }

  private message(schedule: Schedule, occurrence: string, at: number): NewQueuedMessage {
    return {
      conversationKey: `schedule:${schedule.id}:${occurrence}`,
      channel: schedule.channel,
      ts: "",
      threadTs: null,
      user: schedule.createdBy,
      text: scheduledTaskInput(schedule, at),
      scheduleId: schedule.id,
    };
  }

  /**
   * Queue every schedule that is due, then move it to its next run time. A schedule that was
   * due several times (the agent was down) runs once.
   */
  tick(onError: (schedule: Schedule, err: unknown) => void = () => {}): number {
    // Retry stalled queue cleanup even when no schedule is due.
    this.scheduler.pump();
    let queued = 0;
    for (const schedule of this.store.due()) {
      const dueAt = schedule.nextRunAt;
      if (dueAt === null) continue;
      try {
        const now = this.now();
        const next = schedule.cron === null ? null : nextRun(schedule.cron, schedule.timezone, now);
        const outcome = this.store.advanceDue(
          schedule.id,
          dueAt,
          next,
          () => this.scheduler.enqueue(this.message(schedule, String(dueAt), now)) !== null,
        );
        if (outcome === "queued") {
          queued++;
          this.scheduler.pump();
        }
        if (outcome === "skipped") onError(schedule, new Error("queue is full; skipped this run"));
      } catch (err) {
        onError(schedule, err);
      }
    }
    return queued;
  }
}
