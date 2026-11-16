import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Input, ThreadItem } from "@openai/codex-sdk";
import type { Reply, ReplyTarget, ThreadContext } from "../channels/types.ts";
import { openStateDb, type QueuedMessage, SessionStore, type UsageRecord } from "../state/index.ts";
import { REPLY_SCHEMA } from "./reply.ts";
import {
  createTurnRunner,
  formatInput,
  isNewSessionCommand,
  NEW_SESSION_REPLY,
  PASSIVE_LABEL,
  REACTIONS,
  type TurnDeps,
} from "./turn.ts";

const DAY = 24 * 60 * 60 * 1000;

const message = (
  conversationKey = "C1:1.0",
  text = "fix the build",
  ts = "2.0",
): QueuedMessage => ({
  id: 1,
  conversationKey,
  channel: "C1",
  ts,
  threadTs: "1.0",
  user: "U1",
  text,
  scheduleId: null,
  mode: "direct",
  files: [],
});

const json = (message: string, choices: string[] = [], reply = true, files: string[] = []) =>
  JSON.stringify({ reply, message, choices, files });

/**
 * Fake Codex: records calls; streams `items` as started, then `behave` decides the final
 * response (or throws).
 */
function fakeCodex(
  behave: (input: string, signal: AbortSignal) => Promise<string>,
  items: ThreadItem[] = [],
) {
  const calls: { kind: "start" | "resume"; id: string; input: Input; schema: unknown }[] = [];
  let next = 0;
  const thread = (id: string | null) => {
    let threadId = id;
    return {
      get id() {
        return threadId;
      },
      async runStreamed(input: Input, opts: { signal: AbortSignal; outputSchema: unknown }) {
        threadId ??= `thread-${++next}`;
        calls.push({
          kind: id ? "resume" : "start",
          id: threadId,
          input,
          schema: opts.outputSchema,
        });
        async function* events() {
          for (const item of items) yield { type: "item.started", item };
          const prompt = typeof input === "string" ? input : (input[0] as { text: string }).text;
          const text = await behave(prompt, opts.signal);
          yield { type: "item.completed", item: { id: "m", type: "agent_message", text } };
          yield {
            type: "turn.completed",
            usage: {
              input_tokens: 10,
              cached_input_tokens: 4,
              cache_write_input_tokens: 0,
              output_tokens: 3,
              reasoning_output_tokens: 1,
            },
          };
        }
        return { events: events() };
      },
    };
  };
  const codex = {
    startThread: () => thread(null),
    resumeThread: (id: string) => thread(id),
  } as unknown as ReturnType<TurnDeps["codexFor"]>;
  return { codex, calls };
}

function setup(
  behave: Parameters<typeof fakeCodex>[0],
  {
    turnTimeoutMs = 1_000,
    context = { messages: [], omitted: 0 } as ThreadContext,
    items = [] as ThreadItem[],
    newerPending = false,
    /** Posts return no ts (a Telegram chat without topics). */
    noThreads = false,
    /** Posts whose text matches throw. */
    postFails = (_text: string): boolean => false,
  } = {},
) {
  const { codex, calls } = fakeCodex(behave, items);
  const statuses: string[] = [];
  const posts: { text: string; choices: string[]; files?: string[] }[] = [];
  const downloads: string[] = [];
  const usage: UsageRecord[] = [];
  const workspace = mkdtempSync(join(tmpdir(), "elseagent-turn-"));
  const reactions: string[] = [];
  const contextCalls: (string | null)[] = [];
  const targets: ReplyTarget[] = [];
  const reply: Reply = {
    post: async (text, choices = [], files = []) => {
      if (postFails(text)) throw new Error("post failed");
      posts.push(
        files.length ? { text, choices, files: files.map((f) => f.name) } : { text, choices },
      );
      return noThreads ? undefined : `9${posts.length}.0`; // ts of the posted message
    },
    react: async (n) => void reactions.push(`+${n}`),
    unreact: async (n) => void reactions.push(`-${n}`),
    setStatus: async (text) => void statuses.push(text),
  };
  const sessions = new SessionStore(openStateDb(":memory:"));
  const run = createTurnRunner({
    codexFor: () => codex,
    statusOptions: { minIntervalMs: 0, refreshMs: 60_000 },
    sessions,
    threadOptions: { workingDirectory: workspace },
    queue: { hasNewerPending: () => newerPending },
    replyTo: (target) => {
      targets.push(target);
      return reply;
    },
    usage: { record: (r) => void usage.push(r) },
    now: () => 5_000,
    download: async (_chat, file, dest) => {
      downloads.push(file.name);
      await Bun.write(dest, `contents of ${file.name}`);
    },
    threadContext: async (_m, afterTs) => {
      contextCalls.push(afterTs);
      return context;
    },
    turnTimeoutMs,
    sessionIdleMs: 7 * DAY,
    logger: { warn: () => {} },
  });
  return {
    run,
    calls,
    sessions,
    posts,
    reactions,
    contextCalls,
    statuses,
    targets,
    downloads,
    workspace,
    usage,
  };
}

const never = new AbortController().signal;

describe("turn runner", () => {
  test("starts a Codex thread with the reply schema, posts the answer, remembers the thread", async () => {
    const { run, calls, posts, reactions, sessions } = setup(async () => json("Fixed it."));
    await run(message(), never);
    expect(calls).toEqual([
      { kind: "start", id: "thread-1", input: "<@U1>: fix the build", schema: REPLY_SCHEMA },
    ]);
    expect(posts).toEqual([{ text: "Fixed it.", choices: [] }]);
    // Success just removes "working": no extra reaction, the reply says it's done.
    expect(reactions).toEqual([
      `-${REACTIONS.queued}`,
      `+${REACTIONS.working}`,
      `-${REACTIONS.working}`,
    ]);
    expect(sessions.get("C1:1.0", DAY)).toEqual({ threadId: "thread-1", lastSeenTs: "2.0" });
  });

  test("posts choices as buttons", async () => {
    const { run, posts } = setup(async () => json("Which branch?", ["main", "release"]));
    await run(message(), never);
    expect(posts).toEqual([{ text: "Which branch?", choices: ["main", "release"] }]);
  });

  test("continues the same Codex thread and only fetches context it hasn't seen", async () => {
    const { run, calls, contextCalls } = setup(async () => json("ok"));
    await run(message("C1:1.0", "first", "2.0"), never);
    await run(message("C1:1.0", "second", "7.0"), never);
    expect(calls.map((c) => [c.kind, c.id])).toEqual([
      ["start", "thread-1"],
      ["resume", "thread-1"],
    ]);
    expect(contextCalls).toEqual([null, "2.0"]);
  });

  test("includes unseen thread messages before the message for the agent", async () => {
    const context = { messages: [{ user: "U2", text: "it fails on CI too" }], omitted: 0 };
    const { run, calls } = setup(async () => json("ok"), { context });
    await run(message(), never);
    expect(calls[0]?.input).toBe(
      "Messages in this thread since your last reply:\n<@U2>: it fails on CI too\n\n" +
        "Message for you:\n<@U1>: fix the build",
    );
  });

  test("other conversations get their own thread", async () => {
    const { run, calls } = setup(async () => json("ok"));
    await run(message("C1:1.0"), never);
    await run(message("C1:9.0"), never);
    expect(calls.map((c) => c.id)).toEqual(["thread-1", "thread-2"]);
  });

  const waitForAbort = (_: string, signal: AbortSignal) =>
    new Promise<string>((_resolve, reject) => {
      if (signal.aborted) reject(new Error("aborted"));
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    });

  test("stops a turn that runs past the timeout and keeps the session", async () => {
    const { run, posts, reactions, sessions } = setup(waitForAbort, { turnTimeoutMs: 20 });
    await run(message(), never);
    expect(posts[0]?.text).toContain("took longer than");
    expect(reactions.at(-1)).toBe(`+${REACTIONS.failed}`);
    expect(sessions.get("C1:1.0", DAY)?.threadId).toBe("thread-1");
  });

  test("on shutdown, tells the thread to resend", async () => {
    const { run, posts } = setup(waitForAbort);
    const shutdown = new AbortController();
    const turn = run(message(), shutdown.signal);
    shutdown.abort();
    await turn;
    expect(posts[0]?.text).toContain("restarted");
  });

  test("reports Codex errors in the thread", async () => {
    const { run, posts, reactions } = setup(async () => {
      throw new Error("model overloaded");
    });
    await run(message(), never);
    expect(posts).toEqual([
      {
        text: "The task failed. Reply in this thread to ask me to investigate or continue.",
        choices: [],
      },
    ]);
    expect(reactions.at(-1)).toBe(`+${REACTIONS.failed}`);
  });
});

describe("/new", () => {
  const command = (): QueuedMessage => ({
    id: 9,
    conversationKey: "D1",
    channel: "D1",
    ts: "",
    threadTs: null,
    user: "U1",
    text: "/new",
    scheduleId: null,
    mode: "direct",
    files: [],
  });
  const dm = (text: string, ts: string): QueuedMessage => ({
    ...command(),
    ts,
    text,
  });

  test("the DM slash command starts the conversation over without running Codex", async () => {
    const { run, calls, posts, sessions } = setup(async () => json("ok"));
    await run(dm("remember 42", "1.0"), never);
    expect(sessions.get("D1", DAY)?.threadId).toBe("thread-1");

    await run(command(), never);
    expect(posts.at(-1)?.text).toBe(NEW_SESSION_REPLY);
    expect(calls).toHaveLength(1); // no Codex turn for the command
    expect(sessions.get("D1", DAY)?.threadId).toBeNull();

    await run(dm("what did I say?", "3.0"), never);
    expect(calls.map((c) => [c.kind, c.id])).toEqual([
      ["start", "thread-1"],
      ["start", "thread-2"], // a new Codex session
    ]);
  });

  test("typing /new as a message is just text for Codex", () => {
    expect(isNewSessionCommand(command())).toBe(true);
    expect(isNewSessionCommand({ ...command(), ts: "5.0" })).toBe(false);
    expect(isNewSessionCommand({ ...command(), scheduleId: 1 })).toBe(false);
  });
});

describe("typing status", () => {
  test("shows what Codex is doing, then clears before the reply", async () => {
    const items = [
      { id: "1", type: "reasoning", text: "" },
      {
        id: "2",
        type: "command_execution",
        command: "bun test",
        aggregated_output: "",
        status: "in_progress",
      },
    ] as ThreadItem[];
    const { run, statuses, posts } = setup(async () => json("done"), { items });
    await run(message(), never);
    expect(statuses).toEqual(["is thinking…", "is running `bun test`…", ""]);
    expect(posts).toHaveLength(1);
  });

  test("is cleared when the turn fails", async () => {
    const { run, statuses } = setup(async () => {
      throw new Error("boom");
    });
    await run(message(), never);
    expect(statuses).toEqual(["is thinking…", ""]);
  });
});

describe("scheduled runs", () => {
  const scheduled = (): QueuedMessage => ({
    id: 7,
    conversationKey: "schedule:3:1000",
    channel: "C_OPS",
    ts: "",
    threadTs: null,
    user: "U1",
    text: 'Scheduled task "daily" (#3): check CI',
    scheduleId: 3,
    mode: "direct",
    files: [],
  });

  test("posts the result as a new conversation and keeps the session", async () => {
    const { run, calls, posts, reactions, sessions, contextCalls, statuses, targets } = setup(
      async () => json("CI is green."),
    );
    await run(scheduled(), never);
    // The post starts a conversation of its own (in Telegram, a new topic).
    expect(targets[0]).toMatchObject({ channel: "C_OPS", startsThread: true });
    expect(calls).toEqual([
      {
        kind: "start",
        id: "thread-1",
        input: 'Scheduled task "daily" (#3): check CI',
        schema: REPLY_SCHEMA,
      },
    ]);
    expect(posts).toEqual([{ text: "⏰ **daily**\n\nCI is green.", choices: [] }]);
    expect(reactions).toEqual([]);
    expect(statuses).toEqual([]); // and no thread to show a status in
    expect(contextCalls).toEqual([]);
    // Follow-ups in the posted message's thread continue this run's session.
    expect(sessions.get("C_OPS:91.0", DAY)).toEqual({ threadId: "thread-1", lastSeenTs: "91.0" });
    expect(sessions.get("schedule:3:1000", DAY)).toBeNull();
  });

  test("failure posts an error, hides raw details, and a reply resumes the run", async () => {
    let attempt = 0;
    const { run, calls, posts, reactions, sessions } = setup(async () => {
      if (++attempt === 1) throw new Error('Failed to parse item: {"private":"webpage output');
      return json("Recovered.");
    });
    await run(scheduled(), never);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toBe(
      "⏰ **daily**\n\nThe task failed. Reply in this thread to ask me to investigate or continue.",
    );
    expect(JSON.stringify(posts)).not.toContain("private");
    expect(reactions).toEqual([]);
    expect(sessions.get("C_OPS:91.0", DAY)?.threadId).toBe("thread-1");
    expect(sessions.followState("C_OPS:91.0")?.repliedTo).toBe("U1");

    await run(
      { ...message("C_OPS:91.0", "continue", "99.0"), channel: "C_OPS", threadTs: "91.0" },
      never,
    );
    expect(calls[1]).toMatchObject({ kind: "resume", id: "thread-1" });
    expect(posts.at(-1)?.text).toBe("Recovered.");
  });

  test("nothing is posted before Codex starts", async () => {
    const { run, posts } = setup(async () => {
      expect(posts).toEqual([]);
      return json("Done.");
    });
    await run(scheduled(), never);
  });

  test("reply false stays silent even with direct mode and leaves no conversation", async () => {
    const { run, posts, reactions, statuses, sessions, usage } = setup(async () =>
      json("", [], false),
    );
    await run(scheduled(), never);
    expect(posts).toEqual([]);
    expect(reactions).toEqual([]);
    expect(statuses).toEqual([]);
    expect(sessions.get("C_OPS:91.0", DAY)).toBeNull();
    expect(sessions.get("schedule:3:1000", DAY)).toBeNull();
    expect(usage).toHaveLength(1);
  });

  test("long results put a summary in the channel and details, buttons and files in its thread", async () => {
    const details =
      `Two services need attention.\n\n${"Investigation details. ".repeat(100)}`.trim();
    const { run, posts, targets, sessions, workspace } = setup(async () =>
      json(details, ["Investigate", "Dismiss"], true, ["report.txt"]),
    );
    await Bun.write(join(workspace, "report.txt"), "Full report");
    await run(scheduled(), never);
    expect(posts).toEqual([
      { text: "⏰ **daily**\n\nTwo services need attention.\n\nDetails in thread.", choices: [] },
      { text: details, choices: ["Investigate", "Dismiss"], files: ["report.txt"] },
    ]);
    expect(targets[1]).toEqual({ channel: "C_OPS", ts: "", threadTs: "91.0" });
    expect(sessions.get("C_OPS:91.0", DAY)?.threadId).toBe("thread-1");
  });

  test("a silent run's Codex thread is tracked so cleanup can delete it", async () => {
    const { run, sessions } = setup(async () => json("", [], false));
    await run(scheduled(), never);
    expect(sessions.unusedThreads(Date.now() + 1)).toEqual([
      { threadId: "thread-1", conversationKey: "schedule:3:1000" },
    ]);
  });

  test("without a thread (Telegram without topics) long results follow in the chat", async () => {
    const details = `Summary.\n\n${"Details. ".repeat(200)}`.trim();
    const { run, posts, targets } = setup(async () => json(details, ["Retry"]), {
      noThreads: true,
    });
    await run(scheduled(), never);
    expect(posts).toEqual([
      { text: "⏰ **daily**\n\nSummary.\n\nDetails in thread.", choices: [] },
      { text: details, choices: ["Retry"] },
    ]);
    expect(targets[1]).toEqual({ channel: "C_OPS", ts: "" });
  });

  test("an error after the result was posted goes in its thread", async () => {
    const details = `Summary.\n\n${"Details. ".repeat(200)}`.trim();
    const { run, posts, targets, sessions } = setup(async () => json(details), {
      postFails: (text) => text === details,
    });
    await run(scheduled(), never);
    expect(posts.map((p) => p.text)).toEqual([
      "⏰ **daily**\n\nSummary.\n\nDetails in thread.",
      "The task failed. Reply in this thread to ask me to investigate or continue.",
    ]);
    expect(targets.at(-1)).toEqual({ channel: "C_OPS", ts: "", threadTs: "91.0" });
    expect(sessions.get("C_OPS:91.0", DAY)?.threadId).toBe("thread-1");
  });

  test("each run is a new session", async () => {
    const { run, calls } = setup(async () => json("ok"));
    await run(scheduled(), never);
    await run(scheduled(), never);
    expect(calls.map((c) => [c.kind, c.id])).toEqual([
      ["start", "thread-1"],
      ["start", "thread-2"],
    ]);
  });
});

describe("cancellation", () => {
  test("a cancelled turn says who stopped it", async () => {
    const { run, posts, reactions } = setup(
      (_input, signal) =>
        new Promise<string>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    const controller = new AbortController();
    const turn = run(message(), controller.signal);
    await Bun.sleep(5);
    controller.abort({ kind: "cancelled", by: "U_ADMIN" });
    await turn;
    expect(posts[0]?.text).toBe("Stopped by <@U_ADMIN>.");
    expect(reactions.at(-1)).toBe(`+${REACTIONS.failed}`);
  });
});

describe("formatInput", () => {
  test("is just the message when there is no new context", () => {
    expect(
      formatInput(
        { user: "U9", text: "hi", scheduleId: null, mode: "direct" },
        { messages: [], omitted: 0 },
      ),
    ).toBe("<@U9>: hi");
  });

  test("notes omitted messages", () => {
    const input = formatInput(
      { user: "U9", text: "hi", scheduleId: null, mode: "direct" },
      { messages: [{ user: "U1", text: "a" }], omitted: 3 },
    );
    expect(input).toContain("(3 earlier messages omitted)\n<@U1>: a");
  });
});

describe("passive messages (thread replies that don't mention the agent)", () => {
  const passive = (ts = "3.0"): QueuedMessage => ({
    ...message("C1:1.0", "we could also cache it", ts),
    user: "U2",
    mode: "passive",
  });

  test("Codex may stay silent: nothing posted, no reactions or status, the message is seen", async () => {
    const { run, calls, posts, reactions, statuses, sessions } = setup(async () =>
      json("", [], false),
    );
    sessions.addressed("C1:1.0");
    await run(passive(), never);
    expect(calls[0]?.input).toContain(PASSIVE_LABEL);
    expect(posts).toEqual([]);
    expect(reactions).toEqual([]);
    expect(statuses).toEqual([]);
    expect(sessions.get("C1:1.0", DAY)?.lastSeenTs).toBe("3.0");
  });

  test("when it does reply, the thread counts as answered for that person", async () => {
    const { run, posts, sessions } = setup(async () => json("Caching won't help here: …"));
    sessions.addressed("C1:1.0");
    sessions.noteUnanswered("C1:1.0");
    await run(passive(), never);
    expect(posts).toEqual([{ text: "Caching won't help here: …", choices: [] }]);
    expect(sessions.followState("C1:1.0")).toMatchObject({ unanswered: 0, repliedTo: "U2" });
  });

  test("skipped without running Codex when already seen or a later message is queued", async () => {
    const seen = setup(async () => json("x"));
    seen.sessions.touch("C1:1.0", "thread-9", "5.0");
    await seen.run(passive("4.0"), never);
    const newer = setup(async () => json("x"), { newerPending: true });
    await newer.run(passive(), never);
    expect([...seen.calls, ...newer.calls]).toEqual([]);
  });

  test("failures stay out of the thread", async () => {
    const { run, posts, reactions } = setup(async () => {
      throw new Error("boom");
    });
    await run(passive(), never);
    expect(posts).toEqual([]);
    expect(reactions).toEqual([]);
  });

  test("superseded by a direct message: silent, and the message stays unseen", async () => {
    const { run, posts, sessions } = setup(
      (_input, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    sessions.touch("C1:1.0", "thread-9", "2.0");
    const controller = new AbortController();
    const turn = run(passive(), controller.signal);
    await Bun.sleep(5);
    controller.abort({ kind: "superseded" });
    await turn;
    expect(posts).toEqual([]);
    // The direct turn will get the passive message as thread context.
    expect(sessions.get("C1:1.0", DAY)?.lastSeenTs).toBe("2.0");
  });

  test("a direct message is always answered, even if Codex says reply: false", async () => {
    const { run, posts } = setup(async () => json("Done.", [], false));
    await run(message(), never);
    expect(posts).toEqual([{ text: "Done.", choices: [] }]);
  });
});

describe("files", () => {
  test("attachments are downloaded into the workspace and listed; images are shown", async () => {
    const context: ThreadContext = {
      messages: [
        {
          user: "U2",
          text: "here's the log",
          files: [{ name: "build.log", mimetype: "text/plain", ref: "r1" }],
        },
      ],
      omitted: 0,
    };
    const { run, calls, downloads, workspace } = setup(async () => json("Seen."), { context });
    await run(
      { ...message(), files: [{ name: "shot.png", mimetype: "image/png", size: 10, ref: "r2" }] },
      never,
    );
    expect(downloads).toEqual(["build.log", "shot.png"]);
    const dir = "attachments/C1-1.0";
    expect(await Bun.file(join(workspace, dir, "build.log")).text()).toBe("contents of build.log");
    expect(calls[0]?.input).toEqual([
      {
        type: "text",
        text: [
          "Messages in this thread since your last reply:",
          "<@U2>: here's the log",
          `[attached file: ${dir}/build.log (text/plain, 21 B)]`,
          "",
          "Message for you:",
          "<@U1>: fix the build",
          `[attached file: ${dir}/shot.png (image/png, 20 B)]`,
        ].join("\n"),
      },
      { type: "local_image", path: join(workspace, dir, "shot.png") },
    ]);
  });

  test("a file sent again gets a new name; a failed download is reported to Codex", async () => {
    const { run, calls, workspace } = setup(async () => json("ok"));
    const file = { name: "a.txt", ref: "r" };
    await run({ ...message(), files: [file] }, never);
    await run({ ...message(), files: [file] }, never);
    expect(await Bun.file(join(workspace, "attachments/C1-1.0/a-1.txt")).exists()).toBe(true);
    expect(calls[1]?.input).toContain("attachments/C1-1.0/a-1.txt");

    const big = { name: "huge.bin", size: 500 * 1024 * 1024, ref: "r" };
    await run({ ...message(), files: [big] }, never);
    expect(calls[2]?.input).toContain(
      "[attached file huge.bin: could not be downloaded (larger than 100 MB)]",
    );
  });

  test("files named in the reply are sent; missing ones are mentioned", async () => {
    const { run, posts, workspace } = setup(async () =>
      json("Here's the chart.", [], true, ["chart.png", "out/missing.csv"]),
    );
    await Bun.write(join(workspace, "chart.png"), "png");
    await run(message(), never);
    expect(posts).toEqual([
      {
        text: "Here's the chart.\n\n_Could not attach `out/missing.csv`: not found._",
        choices: [],
        files: ["chart.png"],
      },
    ]);
  });

  test("files alone are a reply", async () => {
    const { run, posts, workspace } = setup(async () => json("", [], true, ["r.txt"]));
    await Bun.write(join(workspace, "r.txt"), "report");
    await run(message(), never);
    expect(posts).toEqual([{ text: "", choices: [], files: ["r.txt"] }]);
  });
});

describe("sessions and usage", () => {
  test("records each completed turn's token usage", async () => {
    const { run, usage } = setup(async () => json("ok"));
    await run(message(), never);
    expect(usage).toEqual([
      {
        at: 5_000,
        conversationKey: "C1:1.0",
        channel: "C1",
        user: "U1",
        scheduleId: null,
        threadId: "thread-1",
        inputTokens: 10,
        cachedInputTokens: 4,
        outputTokens: 3,
        reasoningOutputTokens: 1,
        durationMs: 0,
      },
    ]);
  });

  test("a deleted Codex session is replaced by a new one that reads the whole thread", async () => {
    const s = setup(async () => {
      if (s.calls.at(-1)?.kind === "resume") {
        throw new Error("thread/resume failed: no rollout found for thread id t-old");
      }
      return json("Back.");
    });
    s.sessions.touch("C1:1.0", "t-old", "1.5");
    await s.run(message(), never);
    expect(s.calls.map((c) => c.kind)).toEqual(["resume", "start"]);
    expect(s.contextCalls).toEqual(["1.5", null]);
    expect(s.posts).toEqual([{ text: "Back.", choices: [] }]);
    expect(s.sessions.get("C1:1.0", DAY)?.threadId).toBe("thread-1");
  });
});
