import type {
  Codex,
  Input,
  Thread,
  ThreadItem,
  ThreadOptions,
  TurnOptions,
  Usage,
} from "@openai/codex-sdk";
import {
  type Attachment,
  type ContextMessage,
  NEW_SESSION_COMMAND,
  NO_CONTEXT,
  type OutgoingFile,
  type Reaction,
  type Reply,
  type ReplyTarget,
  type ThreadContext,
} from "../channels/types.ts";
import type { MessageQueue, QueuedMessage, SessionStore, UsageStore } from "../state/index.ts";
import { MINUTE_MS } from "../util/time.ts";
import {
  attachmentsDir,
  describeFiles,
  isImage,
  MAX_IMAGES,
  resolveReplyFiles,
  type SavedFile,
  saveAttachments,
} from "./files.ts";
import {
  FailedTurnError,
  InterruptedStreamError,
  type PendingOperation,
  type RecoveryCheckpoint,
  type RecoveryStore,
  recoveryInput,
} from "./recovery.ts";
import { formatScheduledReply, parseReply, REPLY_SCHEMA } from "./reply.ts";
import { type StopReason, stopReason, type TurnRunner } from "./scheduler.ts";
import { scheduledTaskName } from "./schedules.ts";
import { describeItem, type StatusOptions, StatusTicker, THINKING } from "./status.ts";

/**
 * The `/new` slash command (DMs only): start the DM over with a new Codex session. It is
 * queued without a chat message (empty ts), unlike a user typing "/new" in a thread, which is
 * just text for Codex.
 */
export function isNewSessionCommand(
  message: Pick<QueuedMessage, "text" | "ts" | "scheduleId">,
): boolean {
  return message.scheduleId === null && message.ts === "" && message.text === NEW_SESSION_COMMAND;
}

/** Posted when a turn was cut short by a restart (at shutdown, or found at the next startup). */
export const RESTARTED_REPLY = "The agent restarted while working on this. Send it again to retry.";

export const NEW_SESSION_REPLY =
  "Started a new session. I won't remember what we discussed before this point.";

/**
 * Run a turn streamed, reporting each item as it starts, and return the final response and the
 * turn's token usage. Same result handling as the SDK's `Thread.run`.
 */
export async function runStreamed(
  thread: Pick<Thread, "runStreamed">,
  input: Input,
  options: TurnOptions,
  onItemStarted: (item: ThreadItem) => void,
): Promise<{ finalResponse: string; usage: Usage | null }> {
  let finalResponse = "";
  let usage: Usage | null = null;
  let completed = false;
  const pending = new Map<string, PendingOperation>();
  try {
    const { events } = await thread.runStreamed(input, options);
    for await (const event of events) {
      if (event.type === "item.started") {
        if (["command_execution", "mcp_tool_call", "file_change"].includes(event.item.type)) {
          pending.set(event.item.id, { id: event.item.id, type: event.item.type });
        }
        onItemStarted(event.item);
      } else if (event.type === "item.completed") {
        pending.delete(event.item.id);
        if (event.item.type === "agent_message") finalResponse = event.item.text;
      } else if (event.type === "turn.completed") {
        usage = event.usage;
        completed = true;
      } else if (event.type === "turn.failed") {
        throw new FailedTurnError(event.error.message, [...pending.values()]);
      }
    }
    if (!completed) throw new Error("Event stream ended without turn.completed");
  } catch (err) {
    if (err instanceof FailedTurnError && !options.signal?.aborted) throw err;
    throw new InterruptedStreamError(err, [...pending.values()], completed);
  }
  return { finalResponse, usage };
}

/** Resuming a Codex thread that was deleted (e.g. by cleanup) fails with this. */
export const isMissingThread = (err: unknown) => /no rollout found/i.test(String(err));

export interface TurnDeps {
  /** A Codex client for this turn (it carries the turn's identity to the elseagent MCP tools). */
  codexFor(message: QueuedMessage): Pick<Codex, "startThread" | "resumeThread">;
  /** Throttling of the thread's loading status (tests shorten it). */
  statusOptions?: StatusOptions;
  sessions: Pick<SessionStore, "get" | "touch" | "trackThread" | "reset" | "replied">;
  /** To skip a passive message that a later queued message will see as context anyway. */
  queue: Pick<MessageQueue, "hasNewerPending">;
  threadOptions: ThreadOptions;
  replyTo(target: ReplyTarget): Reply;
  /** Thread messages after `afterTs` (null: from the start) and before the message itself. */
  threadContext(message: QueuedMessage, afterTs: string | null): Promise<ThreadContext>;
  /** Where each completed turn's token usage is recorded. */
  usage?: Pick<UsageStore, "record">;
  recovery?: Pick<RecoveryStore, "get" | "save" | "clear">;
  now?: () => number;
  /** Download a file attached to a message in `chat` (see `Channel.download`). */
  download(chat: string, file: Attachment, dest: string, signal?: AbortSignal): Promise<void>;
  turnTimeoutMs: number;
  sessionIdleMs: number;
  logger?: Pick<Console, "warn">;
}

/** The conversation a turn is recorded under, and the last message it has seen there. */
interface ConversationRef {
  key: string;
  lastSeenTs: string;
}

/** A message as Codex sees it, with its attachments once downloaded. */
type Said = Pick<ContextMessage, "user" | "text"> & { saved?: SavedFile[] };

const line = (m: Said, workspace: string) =>
  [`<@${m.user}>: ${m.text}`, ...describeFiles(m.saved ?? [], workspace)].join("\n");

/** How a follow-up is introduced: a reply to the agent, which may be a mere acknowledgement. */
export const FOLLOWUP_LABEL =
  "Reply to your last message (no mention). Answer it; if it is only an acknowledgement " +
  "(thanks, ok) that needs no answer, set reply to false:";

/** How a passive message is introduced: Codex decides whether it is for it. */
export const PASSIVE_LABEL =
  "Latest message in the thread, not addressed to you. Reply only if it is meant for you or " +
  "you can really help; otherwise set reply to false:";

/**
 * What Codex sees: thread messages it hasn't seen yet, then the message addressed to it (or, for
 * a passive message, the latest one). A scheduled run's text is the task description itself.
 */
export function formatInput(
  message: Pick<QueuedMessage, "user" | "text" | "scheduleId" | "mode"> & Said,
  context: { messages: Said[]; omitted: number },
  /** Attachment paths are shown relative to it (Codex's working directory). */
  workspace = "",
): string {
  if (message.scheduleId !== null) return message.text;
  const current = line(message, workspace);
  const label =
    message.mode === "passive"
      ? PASSIVE_LABEL
      : message.mode === "followup"
        ? FOLLOWUP_LABEL
        : "Message for you:";
  if (context.messages.length === 0) {
    return message.mode === "direct" ? current : `${label}\n${current}`;
  }
  const omitted = context.omitted ? `(${context.omitted} earlier messages omitted)\n` : "";
  return [
    "Messages in this thread since your last reply:",
    omitted + context.messages.map((m) => line(m, workspace)).join("\n"),
    "",
    label,
    current,
  ].join("\n");
}

/**
 * Posts a turn's messages and keeps track of the conversation they belong to. A chat message is
 * answered in its conversation. A scheduled run has none until it posts: its first message (the
 * notification) opens one, and whatever follows goes in that message's thread.
 */
function createPoster(
  replyTo: TurnDeps["replyTo"],
  reply: Reply,
  message: QueuedMessage,
  scheduled: boolean,
) {
  let replied = false;
  let conversation: ConversationRef | null = scheduled
    ? null
    : { key: message.conversationKey, lastSeenTs: message.ts };
  const taskTitle = scheduled
    ? scheduledTaskName(message.text) || `Task #${message.scheduleId}`
    : "";
  // A scheduled run's notification, once posted: later posts (an error) go in its thread.
  let resultTs: string | undefined;
  const inThread = (ts: string) => replyTo({ channel: message.channel, ts: "", threadTs: ts });

  return {
    /** Whether the agent has answered in the conversation. */
    get replied() {
      return replied;
    },
    /** Where the turn is recorded; null for a scheduled run that has posted nothing. */
    get conversation() {
      return conversation;
    },
    async post(text: string, choices: string[] = [], files: OutgoingFile[] = []): Promise<void> {
      if (!scheduled) {
        await reply.post(text, choices, files);
        replied = true;
        return;
      }
      if (resultTs) {
        await inThread(resultTs).post(text, choices, files);
        return;
      }
      const { root, details } = formatScheduledReply(taskTitle, text);
      const ts = await reply.post(root, details ? [] : choices, details ? [] : files);
      replied = true;
      if (ts) {
        resultTs = ts;
        conversation = { key: `${message.channel}:${ts}`, lastSeenTs: ts };
      }
      if (!details) return;
      // Without a thread (a Telegram chat without topics) the details follow in the chat.
      const target = ts ? inThread(ts) : replyTo({ channel: message.channel, ts: "" });
      await target.post(details, choices, files);
    },
  };
}

/** The operations a failed turn left without a confirmed result, if any. */
function interruptionOf(err: unknown): InterruptedStreamError | undefined {
  if (err instanceof InterruptedStreamError) return err;
  if (err instanceof FailedTurnError && err.pending.length) {
    return new InterruptedStreamError(err, err.pending);
  }
  return undefined;
}

/**
 * Whether a lost event stream may be continued: one bounded continuation of the SAME session,
 * never a replay of the request. Not when a tool was in flight (now or at an earlier
 * interruption): its side effects may already have happened.
 */
function canContinue(
  err: unknown,
  checkpoint: RecoveryCheckpoint | null | undefined,
  passive: boolean,
): err is InterruptedStreamError {
  return (
    err instanceof InterruptedStreamError &&
    !err.pending.length &&
    !err.completed &&
    !checkpoint?.pending.length &&
    !passive
  );
}

/**
 * After a turn, in the conversation it is recorded under: remember the operations an
 * interruption left unconfirmed, or clear the checkpoint once a turn completes with none pending.
 */
async function updateCheckpoint(
  recovery: NonNullable<TurnDeps["recovery"]>,
  conversation: string,
  turn: {
    threadId: string;
    interruption?: InterruptedStreamError;
    failed: boolean;
    now: () => number;
  },
): Promise<void> {
  if (turn.interruption) {
    await recovery.save(conversation, {
      threadId: turn.threadId,
      pending: turn.interruption.pending,
      at: new Date(turn.now()).toISOString(),
    });
  } else if (!turn.failed) {
    // A completed conversational reply is not proof that an uncertain write was reconciled.
    const prior = await recovery.get(conversation);
    if (!prior?.pending.length) await recovery.clear(conversation);
  }
}

/**
 * What a turn that did not finish tells the chat (`post`) and whether the error is logged (`log`).
 * A superseded turn says nothing: the direct message that took over sees it as context. Neither
 * does a passive one, unless someone stopped it: nobody asked, so no errors or timeouts in the
 * thread.
 */
export function failureNotice({
  stopped,
  timedOut,
  passive,
  unconfirmed,
  turnTimeoutMs,
}: {
  stopped: StopReason | null;
  timedOut: boolean;
  passive: boolean;
  /** An operation was running when the stream was lost. */
  unconfirmed: boolean;
  turnTimeoutMs: number;
}): { post?: string; log?: "passive" | "failed" } {
  if (stopped?.kind === "superseded") return {};
  if (passive && stopped?.kind !== "cancelled") return { log: "passive" };
  if (stopped?.kind === "cancelled") return { post: `Stopped by <@${stopped.by}>.` };
  if (stopped?.kind === "shutdown") return { post: RESTARTED_REPLY };
  if (timedOut) {
    return {
      post:
        `Stopped: this took longer than ${Math.round(turnTimeoutMs / MINUTE_MS)} minutes. ` +
        "The conversation is kept, so you can follow up.",
    };
  }
  return {
    log: "failed",
    post: unconfirmed
      ? "The connection was interrupted while an operation was running. Its result is unconfirmed, so I have not retried it. Reply here to reconcile the saved state and continue."
      : "The task failed. Reply in this thread to ask me to investigate or continue.",
  };
}

/**
 * Run one Codex turn for a queued message.
 *
 * A chat message continues its conversation's Codex thread (or starts one) with the thread
 * messages it hasn't seen, and the reply goes into that thread. A scheduled run always starts a
 * new Codex thread; when it posts a result or an error, the message opens a
 * thread, where replies continue the run's session like any conversation.
 *
 * A passive message (a thread reply that doesn't mention the agent) is quiet: no reactions, no
 * status, no error messages, and Codex may decide not to reply. It is skipped when the session
 * has already seen it or a later message of the conversation is queued.
 */
export function createTurnRunner(deps: TurnDeps): TurnRunner {
  const { sessions, threadOptions, turnTimeoutMs, sessionIdleMs, logger = console } = deps;
  const workspace = threadOptions.workingDirectory ?? process.cwd();
  const now = deps.now ?? Date.now;

  /**
   * Download the files of the message and of the thread context into the conversation's
   * attachments folder, and build Codex's input: the text, plus the newest images as images.
   */
  const withAttachments = async (
    message: QueuedMessage,
    context: ThreadContext,
    signal: AbortSignal,
    /** Files already downloaded in this turn, by ref (a retried input doesn't fetch them again). */
    cache: Map<string, SavedFile>,
  ): Promise<Input> => {
    const dir = attachmentsDir(workspace, message.conversationKey);
    const download = (file: Attachment, dest: string) =>
      deps.download(message.channel, file, dest, signal);
    const save = async (files: Attachment[] = []) => {
      const missing = files.filter((f) => !cache.has(f.ref));
      const saved = await saveAttachments(missing, dir, download);
      missing.forEach((f, i) => {
        const s = saved[i];
        if (s) cache.set(f.ref, s);
      });
      return files.map((f) => cache.get(f.ref)).filter((f): f is SavedFile => f !== undefined);
    };
    const messages: Said[] = [];
    for (const m of context.messages) messages.push({ ...m, saved: await save(m.files) });
    const current = { ...message, saved: await save(message.files) };
    const text = formatInput(current, { ...context, messages }, workspace);
    const all = [...messages, current].flatMap((m) => m.saved ?? []);
    for (const f of all.filter((f) => f.error)) {
      logger.warn(`could not download ${f.name} for ${message.conversationKey}: ${f.error}`);
    }
    const images = all.filter(isImage).slice(-MAX_IMAGES);
    if (images.length === 0) return text;
    return [
      { type: "text", text },
      ...images.map((f) => ({ type: "local_image" as const, path: f.path as string })),
    ];
  };

  return async (message, signal) => {
    const scheduled = message.scheduleId !== null;
    const passive = message.mode === "passive";
    const reply = deps.replyTo({ ...message, startsThread: scheduled });
    // Scheduled runs and slash commands have no user message to react to; passive messages
    // weren't addressed to the agent.
    const quiet = !message.ts || passive;
    const react = (reaction: Reaction) => (quiet ? Promise.resolve() : reply.react(reaction));
    const unreact = (reaction: Reaction) => (quiet ? Promise.resolve() : reply.unreact(reaction));
    await unreact("queued");

    // Handled in the queue like any message, so it waits for a running turn in the same
    // conversation instead of racing it.
    if (isNewSessionCommand(message)) {
      sessions.reset(message.conversationKey, null);
      await deps.recovery?.clear(message.conversationKey);
      await reply.post(NEW_SESSION_REPLY);
      return;
    }
    const session = scheduled ? null : sessions.get(message.conversationKey, sessionIdleMs);
    if (
      passive &&
      ((session?.lastSeenTs && message.ts <= session.lastSeenTs) ||
        deps.queue.hasNewerPending(message.conversationKey, message.id))
    ) {
      return; // seen already, or a later turn will see it as context
    }
    const poster = createPoster(deps.replyTo, reply, message, scheduled);
    await react("working");

    const startedAt = now();
    const codex = deps.codexFor(message);
    let thread = session?.threadId
      ? codex.resumeThread(session.threadId, threadOptions)
      : codex.startThread(threadOptions);
    const timeout = AbortSignal.timeout(turnTimeoutMs);
    const turnSignal = AbortSignal.any([timeout, signal]);

    // The "is thinking…" line at the bottom of the thread (none for scheduled runs, and none
    // for passive messages: the agent may not answer at all).
    const showStatus = !scheduled && !passive;
    const status = new StatusTicker((text) => reply.setStatus(text), deps.statusOptions);
    if (showStatus) status.set(THINKING);

    let failed = true;
    let interruption: InterruptedStreamError | undefined;
    try {
      const checkpoint = await deps.recovery?.get(message.conversationKey);
      const downloaded = new Map<string, SavedFile>();
      // A new session gets the whole thread so far; a continuing one only what it hasn't seen.
      const runTurn = async (afterTs: string | null, recovering = false) => {
        const context = scheduled
          ? NO_CONTEXT
          : await deps.threadContext(message, afterTs).catch((err: Error): ThreadContext => {
              logger.warn(`could not read thread context: ${err.message}`);
              return NO_CONTEXT;
            });
        let input = await withAttachments(message, context, turnSignal, downloaded);
        if (recovering || checkpoint) {
          input = recoveryInput(
            recovering ? "Continue the interrupted task from saved progress." : input,
            checkpoint?.pending ?? [],
          );
        }
        return runStreamed(
          thread,
          input,
          { outputSchema: REPLY_SCHEMA, signal: turnSignal },
          (item) => {
            const text = showStatus && describeItem(item);
            if (text) status.set(text);
          },
        );
      };
      let result: Awaited<ReturnType<typeof runStreamed>>;
      try {
        result = await runTurn(session?.lastSeenTs ?? null);
      } catch (err) {
        // The conversation's Codex session was deleted: start a new one with the whole thread.
        if (turnSignal.aborted) throw err;
        if (session?.threadId && isMissingThread(err)) {
          logger.warn(
            `codex: session ${session.threadId} of ${message.conversationKey} is gone; starting a new one`,
          );
          thread = codex.startThread(threadOptions);
          result = await runTurn(null);
        } else if (canContinue(err, checkpoint, passive) && thread.id) {
          logger.warn(
            `codex: recovering interrupted stream for ${message.conversationKey}: ${err.message}`,
          );
          thread = codex.resumeThread(thread.id, threadOptions);
          result = await runTurn(session?.lastSeenTs ?? null, true);
        } else {
          throw err;
        }
      }
      const { finalResponse, usage } = result;
      if (usage) {
        deps.usage?.record({
          at: now(),
          conversationKey: message.conversationKey,
          channel: message.channel,
          user: scheduled ? "" : message.user,
          scheduleId: message.scheduleId,
          threadId: thread.id,
          inputTokens: usage.input_tokens,
          cachedInputTokens: usage.cached_input_tokens,
          outputTokens: usage.output_tokens,
          reasoningOutputTokens: usage.reasoning_output_tokens,
          durationMs: now() - startedAt,
        });
      }
      await status.stop();
      const { reply: answer, message: text, choices, files: paths } = parseReply(finalResponse);
      // Scheduled checks may stay silent even though their queue mode defaults to direct.
      if (answer || (!scheduled && message.mode === "direct")) {
        const { files, problems } = await resolveReplyFiles(paths, workspace);
        const notes = problems.length ? `\n\n_Could not attach ${problems.join("; ")}._` : "";
        const body = text.trim() + notes;
        // Files alone are a reply too (except for a scheduled run: its text starts the thread).
        const empty = files.length > 0 && !scheduled ? "" : "_(no response)_";
        await poster.post(body.trim() || empty, choices, files);
      }
      failed = false;
    } catch (err) {
      interruption = interruptionOf(err);
      await status.stop();
      const notice = failureNotice({
        stopped: stopReason(signal),
        timedOut: timeout.aborted,
        passive,
        unconfirmed: Boolean(interruption?.pending.length),
        turnTimeoutMs,
      });
      if (notice.log) {
        const what =
          notice.log === "passive"
            ? `passive turn for ${message.conversationKey} ended`
            : `turn failed for ${message.conversationKey}`;
        logger.warn(`codex: ${what}: ${(err as Error).message}`);
      }
      if (notice.post) await poster.post(notice.post);
    } finally {
      await status.stop();
      // Keep the mapping even after a failure: the thread holds whatever context was built.
      // A superseded turn records nothing, so the direct turn gets its message as context.
      const where = poster.conversation;
      const superseded = stopReason(signal)?.kind === "superseded";
      if (thread.id && where && !superseded) sessions.touch(where.key, thread.id, where.lastSeenTs);
      // A silent scheduled run maps no conversation: track its Codex thread for cleanup.
      else if (thread.id && scheduled && !where) {
        sessions.trackThread(thread.id, message.conversationKey);
      }
      if (where && thread.id && deps.recovery) {
        await updateCheckpoint(deps.recovery, where.key, {
          threadId: thread.id,
          interruption,
          failed,
          now,
        });
      }
      if (poster.replied && where) sessions.replied(where.key, message.user);
      await unreact("working");
      if (failed && stopReason(signal)?.kind !== "superseded") await react("failed");
    }
  };
}
