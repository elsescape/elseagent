import type { MessageQueue, NewQueuedMessage, QueuedMessage } from "../state/index.ts";

/**
 * Why a running turn was stopped; carried as the abort signal's `reason`. `superseded`: a passive
 * turn made way for a direct message in the same conversation, which sees it as context.
 */
export type StopReason =
  | { kind: "shutdown" }
  | { kind: "cancelled"; by: string }
  | { kind: "superseded" };

export function stopReason(signal: AbortSignal): StopReason | null {
  if (!signal.aborted) return null;
  const reason = signal.reason as Partial<StopReason> | undefined;
  return reason?.kind === "cancelled" || reason?.kind === "superseded"
    ? (reason as StopReason)
    : { kind: "shutdown" };
}

/** Handles one message (one Codex turn). `signal` aborts on shutdown or cancellation. */
export type TurnRunner = (message: QueuedMessage, signal: AbortSignal) => Promise<void>;

export type SubmitResult =
  | { status: "started" }
  | { status: "queued"; position: number }
  | { status: "rejected" };

export interface SchedulerOptions {
  maxConcurrent: number;
  maxQueue: number;
  onError?: (err: unknown, message: QueuedMessage) => void;
  onQueueError?: (err: unknown, operation: string) => void;
  now?: () => number;
}

export interface RunningTurn {
  message: QueuedMessage;
  /** Unix epoch milliseconds. */
  startedAt: number;
}

interface Running extends RunningTurn {
  controller: AbortController;
  task: Promise<void>;
}

/**
 * Runs queued messages with at most `maxConcurrent` turns at once, oldest first, one at a time
 * per conversation. The queue itself is persistent (SQLite), so pending messages survive restarts.
 */
export class Scheduler {
  private readonly running = new Map<number, Running>();
  private readonly finished = new Set<number>();
  private readonly shutdown = new AbortController();
  private readonly now: () => number;

  constructor(
    private readonly queue: MessageQueue,
    private readonly run: TurnRunner,
    private readonly options: SchedulerOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  get runningCount(): number {
    return this.running.size;
  }

  /** Turns in progress, oldest first. */
  runningTurns(): RunningTurn[] {
    return [...this.running.values()].map(({ message, startedAt }) => ({ message, startedAt }));
  }

  /**
   * Queue a message and start it right away if a slot (and its conversation) is free. A direct
   * message stops a passive turn running in its conversation, so it doesn't wait for it.
   */
  submit(message: NewQueuedMessage): SubmitResult {
    const queued = this.enqueue(message);
    if (!queued) return { status: "rejected" };
    const { id } = queued;
    if (message.mode !== "passive") {
      for (const turn of this.running.values()) {
        if (
          turn.message.conversationKey === message.conversationKey &&
          turn.message.mode === "passive"
        ) {
          turn.controller.abort({ kind: "superseded" } satisfies StopReason);
        }
      }
    }
    this.pump();
    return this.running.has(id)
      ? { status: "started" }
      : { status: "queued", position: this.queue.position(id) };
  }

  /** Persist a message without starting work, so scheduled runs can enqueue in a transaction. */
  enqueue(message: NewQueuedMessage): QueuedMessage | null {
    if (this.shutdown.signal.aborted || this.queue.pendingCount() >= this.options.maxQueue) {
      return null;
    }
    return this.queue.push(message);
  }

  /** Start as many eligible messages as there are free slots. */
  pump(): void {
    for (const id of this.finished) {
      try {
        this.queue.remove(id);
        this.finished.delete(id);
      } catch (err) {
        this.reportQueueError(err, `remove finished message #${id}`);
      }
    }
    while (!this.shutdown.signal.aborted && this.running.size < this.options.maxConcurrent) {
      let message: QueuedMessage | null;
      try {
        message = this.queue.claimNext();
      } catch (err) {
        this.reportQueueError(err, "claim next message");
        return;
      }
      if (!message) return;
      const controller = new AbortController();
      const signal = AbortSignal.any([this.shutdown.signal, controller.signal]);
      const run = async (queued: QueuedMessage) => this.run(queued, signal);
      const task = run(message)
        .catch((err) => {
          try {
            this.options.onError?.(err, message);
          } catch (reportError) {
            this.reportQueueError(reportError, `report error for message #${message.id}`);
          }
        })
        .finally(() => {
          this.finished.add(message.id);
          this.running.delete(message.id);
          this.pump();
        });
      this.running.set(message.id, { message, startedAt: this.now(), controller, task });
    }
  }

  private reportQueueError(err: unknown, operation: string): void {
    try {
      if (this.options.onQueueError) this.options.onQueueError(err, operation);
      else console.warn(`queue: could not ${operation}: ${err}`);
    } catch (reportError) {
      console.warn(`queue: could not report failure to ${operation}: ${reportError}`);
    }
  }

  /** Stop the running turn of a conversation. Returns false if nothing is running there. */
  cancel(conversationKey: string, by: string): boolean {
    for (const turn of this.running.values()) {
      if (turn.message.conversationKey === conversationKey) {
        turn.controller.abort({ kind: "cancelled", by } satisfies StopReason);
        return true;
      }
    }
    return false;
  }

  /** Stop taking work, abort running turns, and wait for them to wrap up. */
  async stop(): Promise<void> {
    this.shutdown.abort({ kind: "shutdown" } satisfies StopReason);
    await Promise.allSettled([...this.running.values()].map((t) => t.task));
  }
}
