import type { Schedule, ScheduleStore } from "../state/index.ts";
import { formatTime, nextRun, ScheduleError } from "./cron.ts";
import type { Scheduler } from "./scheduler.ts";

/** At most this many schedules per agent. */
export const MAX_SCHEDULES = 50;

export interface CreateScheduleInput {
  name: string;
  cron: string;
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
    "characters); the full result is posted in the thread below it. Only when the task is a",
    "check and there is nothing to report, return reply: false to post nothing; otherwise",
    "always reply. Task:",
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
    private readonly scheduler: Pick<Scheduler, "submit">,
    private readonly now: () => number = Date.now,
  ) {}

  create(input: CreateScheduleInput): Schedule {
    if (this.store.count() >= MAX_SCHEDULES) {
      throw new ScheduleError(
        `This agent already has ${MAX_SCHEDULES} schedules; delete some first`,
      );
    }
    const nextRunAt = nextRun(input.cron, input.timezone, this.now());
    return this.store.create({ ...input, nextRunAt });
  }

  /** Queue one run of a schedule now. Returns false if the queue is full. */
  runNow(schedule: Schedule): boolean {
    const at = this.now();
    const result = this.scheduler.submit({
      // Unique per run, so runs never wait on each other or on a conversation.
      conversationKey: `schedule:${schedule.id}:${at}`,
      channel: schedule.channel,
      ts: "",
      threadTs: null,
      user: schedule.createdBy,
      text: scheduledTaskInput(schedule, at),
      scheduleId: schedule.id,
    });
    return result.status !== "rejected";
  }

  /**
   * Queue every schedule that is due, then move it to its next run time. A schedule that was
   * due several times (the agent was down) runs once.
   */
  tick(onError: (schedule: Schedule, err: unknown) => void = () => {}): number {
    let queued = 0;
    for (const schedule of this.store.due()) {
      try {
        if (this.runNow(schedule)) queued++;
        else onError(schedule, new Error("queue is full; skipped this run"));
        this.store.markRun(schedule.id, nextRun(schedule.cron, schedule.timezone, this.now()));
      } catch (err) {
        onError(schedule, err);
      }
    }
    return queued;
  }
}
