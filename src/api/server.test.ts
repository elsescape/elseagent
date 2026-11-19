import { afterEach, describe, expect, test } from "bun:test";
import { Admin } from "../agent/admin.ts";
import { Scheduler, stopReason } from "../agent/scheduler.ts";
import { ScheduleRunner } from "../agent/schedules.ts";
import { ApiSessionStore } from "../state/api-sessions.ts";
import {
  MessageQueue,
  openStateDb,
  type QueuedMessage,
  ScheduleStore,
  SessionStore,
  UsageStore,
} from "../state/index.ts";
import { MemoryStore } from "../state/memory.ts";
import { TodoStore } from "../state/todos.ts";
import { apiConversationKey, createApiChat } from "./channel.ts";
import { EventHub, type LiveEvent, type SessionEvent } from "./events.ts";
import { type ApiEndpoint, startApiServer } from "./server.ts";

const TOKEN = "0123456789abcdef-test";
const SOURCE = { user: "U1", channel: "C1", conversationKey: "C1" };

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
type Body = any;

let endpoint: ApiEndpoint | undefined;
afterEach(async () => {
  await endpoint?.stop();
  endpoint = undefined;
});

/**
 * The API over a real queue and scheduler. A turn runs until the test finishes it: it reports a
 * command, then replies with the message text in capitals (or fails when told to).
 */
function setup({ token, maxQueue = 10 }: { token?: string; maxQueue?: number } = {}) {
  const db = openStateDb(":memory:");
  const queue = new MessageQueue(db);
  const sessions = new SessionStore(db);
  const schedules = new ScheduleStore(db);
  const apiSessions = new ApiSessionStore(db);
  const hub = new EventHub();
  const chat = createApiChat({ hub, sessions: apiSessions });
  const finishers = new Map<string, (outcome?: "fail") => void>();
  const stopped: string[] = [];
  const history: SessionEvent[] = [];
  const historyCalls: { threads: string[]; before?: number }[] = [];

  const run = async (message: QueuedMessage, signal: AbortSignal) => {
    const reply = chat.channel.replyTo(message);
    chat.onCodexEvent(message, {
      type: "item.started",
      item: {
        id: "c1",
        type: "command_execution",
        command: "ls",
        aggregated_output: "",
        status: "in_progress",
      },
    });
    await reply.setStatus("is running `ls`…");
    const outcome = await new Promise<"fail" | "stop" | undefined>((resolve) => {
      finishers.set(message.text, resolve);
      signal.addEventListener("abort", () => resolve("stop"));
    });
    if (outcome === "stop") {
      const reason = stopReason(signal);
      stopped.push(reason?.kind === "cancelled" ? reason.by : "shutdown");
      await reply.post("Stopped.");
    } else if (outcome === "fail") {
      await reply.post("The task failed.");
      await reply.react("failed");
    } else {
      await reply.post(message.text.toUpperCase(), ["More"], [{ name: "a.txt", path: "/w/a.txt" }]);
    }
  };
  const scheduler = new Scheduler(queue, chat.observe(run), { maxConcurrent: 1, maxQueue });
  const admin = new Admin({
    scheduler,
    queue,
    sessions,
    schedules,
    scheduleRunner: new ScheduleRunner(schedules, scheduler),
    usage: new UsageStore(db),
    cleanup: { run: async () => ({}) as never },
    ensureChannel: async (ref) => ref,
    limits: { maxConcurrent: 1, maxQueue, turnTimeoutMinutes: 30, sessionIdleDays: 7 },
    defaultTimezone: "UTC",
  });
  const todos = new TodoStore(db);
  const memories = new MemoryStore(db);
  endpoint = startApiServer({
    host: "127.0.0.1",
    port: 0,
    token,
    admin,
    scheduler,
    queue,
    sessions,
    apiSessions,
    hub,
    todos,
    memories,
    info: { name: "elseagent", version: "1.2.3", model: "gpt-test" },
    history: async (threads, options) => {
      historyCalls.push({ threads, ...options });
      return history;
    },
  });
  const base = endpoint.url;
  const call = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(base + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const get = async (path: string): Promise<Body> => (await call("GET", path)).json();
  const post = async (path: string, body: unknown = {}): Promise<Body> =>
    (await call("POST", path, body)).json();
  const finish = async (text: string, outcome?: "fail") => {
    finishers.get(text)?.(outcome);
    await Bun.sleep(5);
  };
  return {
    base,
    call,
    get,
    post,
    finish,
    hub,
    sessions,
    apiSessions,
    scheduler,
    todos,
    memories,
    stopped,
    history,
    historyCalls,
  };
}

/** Read a session's event stream until `done` says the events so far are enough. */
async function readEvents(
  url: string,
  done: (events: LiveEvent[]) => boolean,
  headers: Record<string, string> = {},
): Promise<{ events: LiveEvent[]; ids: string[] }> {
  const abort = new AbortController();
  const res = await fetch(url, { headers, signal: abort.signal });
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const events: LiveEvent[] = [];
  const ids: string[] = [];
  let buffer = "";
  const decoder = new TextDecoder();
  const timeout = setTimeout(() => abort.abort(), 2000);
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let split = buffer.indexOf("\n\n");
      for (; split !== -1; split = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (!data) continue; // a comment
        events.push(JSON.parse(data));
        ids.push(/^id: (.*)$/m.exec(block)?.[1] ?? "");
      }
      if (done(events)) break;
    }
  } catch (err) {
    if (!abort.signal.aborted) throw err;
  } finally {
    clearTimeout(timeout);
    abort.abort();
  }
  return { events, ids };
}

const ended = (events: LiveEvent[]) => events.some((e) => e.type === "turn_ended");
const types = (events: SessionEvent[]) => events.map((e) => e.type);

describe("access", () => {
  test("with a token, requests must carry it", async () => {
    const { base, call } = setup({ token: TOKEN });
    expect((await fetch(`${base}/status`)).status).toBe(401);
    const wrong = await fetch(`${base}/status`, { headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "missing or wrong bearer token" });
    expect((await fetch(`${base}/sessions/x/events`)).status).toBe(401);
    expect((await call("GET", "/status")).status).toBe(200);
  });

  test("without a token, local requests are let in but other sites' pages are not", async () => {
    const { base, call } = setup();
    expect((await call("GET", "/status")).status).toBe(200);
    const foreign = await call("POST", "/sessions", {}, { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    const same = await call("POST", "/sessions", {}, { origin: new URL(base).origin });
    expect(same.status).toBe(201);
  });

  test("unknown paths and methods answer in JSON", async () => {
    const { base, call } = setup();
    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not found" });
    expect((await call("DELETE", "/status")).status).toBe(404);
    expect((await fetch(base.replace("/api", "/"))).status).toBe(404);
  });
});

describe("dashboard", () => {
  test("status reports the agent and its live state", async () => {
    const { get, post } = setup();
    const { id } = await post("/sessions");
    await post(`/sessions/${id}/messages`, { text: "first" });
    await post(`/sessions/${id}/messages`, { text: "second" });
    const status = await get("/status");
    expect(status).toMatchObject({
      name: "elseagent",
      version: "1.2.3",
      model: "gpt-test",
      limits: { maxConcurrent: 1, maxQueue: 10 },
      queued: 1,
      sessions: 0,
      schedules: 0,
    });
    expect(status.running).toMatchObject([
      { conversation: apiConversationKey(id), user: "web", text: "first" },
    ]);
    expect(Date.parse(status.startedAt)).toBeGreaterThan(0);
    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(await get("/queue")).toMatchObject([{ position: 1, text: "second", user: "web" }]);
  });

  test("lists conversations, schedules, usage, todos and memories", async () => {
    const { get, call, sessions, todos, memories } = setup();
    sessions.touch("C1:1.0", "thread-1", "1.0");
    todos.create("Ship the API", "", SOURCE);
    memories.upsert("deploy-day", "Friday", undefined, SOURCE);
    expect(await get("/conversations")).toMatchObject([
      { conversation: "C1:1.0", codexThreadId: "thread-1" },
    ]);
    expect(await get("/schedules")).toEqual([]);
    expect(await get("/usage?days=3&groupBy=day")).toMatchObject({ timezone: "UTC" });
    expect(await get("/todos")).toMatchObject([{ title: "Ship the API", status: "pending" }]);
    expect(await get("/todos?status=completed")).toEqual([]);
    expect(await get("/memories?q=deploy")).toMatchObject([{ key: "deploy-day" }]);
    expect(await get("/memories?q=nothing")).toEqual([]);
    for (const path of ["/usage?groupBy=moon", "/todos?status=odd", "/queue?limit=0"]) {
      expect((await call("GET", path)).status).toBe(400);
    }
    expect((await call("GET", "/usage?since=garbage")).status).toBe(400);
  });
});

describe("sessions", () => {
  test("create, list, rename and delete", async () => {
    const { call, get, post, sessions } = setup();
    const created = await call("POST", "/sessions", { title: "  Plans " });
    expect(created.status).toBe(201);
    const session: Body = await created.json();
    expect(session).toMatchObject({ title: "Plans", status: "idle" });
    const untitled = await post("/sessions");
    expect(untitled.title).toBe("");
    expect((await get("/sessions")).map((s: { id: string }) => s.id).sort()).toEqual(
      [session.id, untitled.id].sort(),
    );
    const renamed = await call("PATCH", `/sessions/${session.id}`, { title: "Roadmap" });
    expect(await renamed.json()).toMatchObject({ id: session.id, title: "Roadmap" });
    expect((await call("PATCH", `/sessions/${session.id}`, {})).status).toBe(400);

    sessions.touch(apiConversationKey(session.id), "thread-1");
    expect((await call("DELETE", `/sessions/${session.id}`)).status).toBe(204);
    expect(sessions.get(apiConversationKey(session.id), 1e9)).toBeNull();
    expect((await call("GET", `/sessions/${session.id}`)).status).toBe(404);
    expect((await call("DELETE", `/sessions/${session.id}`)).status).toBe(404);
    expect(await get("/sessions")).toHaveLength(1);
  });

  test("a message runs a turn whose events are streamed", async () => {
    const { base, post, get, finish } = setup();
    const { id } = await post("/sessions");
    const stream = readEvents(`${base}/sessions/${id}/events`, ended);
    await Bun.sleep(20);
    const sent = await post(`/sessions/${id}/messages`, { text: "hello there", user: "ada" });
    expect(sent).toEqual({ messageId: expect.any(String), status: "started" });
    expect((await get(`/sessions/${id}`)).session).toMatchObject({
      title: "hello there",
      status: "running",
    });
    await finish("hello there");
    const { events, ids } = await stream;
    expect(types(events)).toEqual([
      "user_message",
      "turn_started",
      "codex",
      "status",
      "reply",
      "turn_ended",
    ]);
    expect(new Set(events.map((e) => e.messageId))).toEqual(new Set([sent.messageId]));
    expect(events[0]).toMatchObject({ text: "hello there", user: "ada" });
    expect(events[2]).toMatchObject({
      event: { type: "item.started", item: { type: "command_execution", command: "ls" } },
    });
    expect(events[3]).toMatchObject({ text: "is running `ls`…" });
    expect(events[4]).toMatchObject({
      text: "HELLO THERE",
      choices: ["More"],
      files: [{ name: "a.txt", path: "/w/a.txt" }],
    });
    expect(events[5]).toMatchObject({ status: "completed" });
    expect(ids).toEqual(events.map((e) => expect.stringMatching(new RegExp(`:${e.seq}$`))));
    expect((await get(`/sessions/${id}`)).session.status).toBe("idle");
  });

  test("a session opens with Codex's history and the turn in progress", async () => {
    const { post, get, finish, sessions, history, historyCalls } = setup();
    const { id } = await post("/sessions");
    sessions.touch(apiConversationKey(id), "thread-1");
    history.push({ type: "turn_started", messageId: "old", at: 1 });
    const before = Date.now();
    const idle = await get(`/sessions/${id}`);
    expect(idle).toMatchObject({ history, live: [], cursor: expect.any(String) });
    expect(historyCalls[0]?.threads).toEqual(["thread-1"]);
    expect(historyCalls[0]?.before).toBeGreaterThanOrEqual(before);

    await post(`/sessions/${id}/messages`, { text: "one" });
    await post(`/sessions/${id}/messages`, { text: "two" });
    const busy = await get(`/sessions/${id}`);
    expect(busy.session.status).toBe("running");
    expect(types(busy.live)).toEqual([
      "user_message",
      "turn_started",
      "codex",
      "status",
      "user_message",
    ]);
    // Whatever Codex has written of the running turn is left to the live events.
    expect(historyCalls[1]?.before).toBe(busy.live[1].at);
    await finish("one");
    const next = await get(`/sessions/${id}`);
    expect(next.live.map((e: LiveEvent) => e.messageId)).not.toContain(busy.live[0].messageId);
    expect(types(next.live)).toEqual(["user_message", "turn_started", "codex", "status"]);
    await finish("two");
    expect((await get(`/sessions/${id}`)).live).toEqual([]);
  });

  test("a stream resumes after a cursor", async () => {
    const { base, post, get, finish } = setup({ token: TOKEN });
    const auth = { authorization: `Bearer ${TOKEN}` };
    const { id } = await post("/sessions");
    await post(`/sessions/${id}/messages`, { text: "one" });
    const { cursor, live } = await get(`/sessions/${id}`);
    expect(live).toHaveLength(4);
    await finish("one"); // the turn ends before the stream is opened
    const resumed = await readEvents(`${base}/sessions/${id}/events?after=${cursor}`, ended, auth);
    expect(types(resumed.events)).toEqual(["reply", "turn_ended"]);
    const viaHeader = await readEvents(`${base}/sessions/${id}/events`, ended, {
      ...auth,
      "last-event-id": resumed.ids[0] ?? "",
    });
    expect(types(viaHeader.events)).toEqual(["turn_ended"]);
  });

  test("stop interrupts the running turn; a failed turn says so", async () => {
    const { base, post, call, finish, stopped } = setup();
    const { id } = await post("/sessions");
    expect(await post(`/sessions/${id}/stop`)).toEqual({ stopped: false });
    const stream = readEvents(`${base}/sessions/${id}/events`, ended);
    await Bun.sleep(20);
    await post(`/sessions/${id}/messages`, { text: "long task" });
    expect((await call("DELETE", `/sessions/${id}`)).status).toBe(409);
    expect(await post(`/sessions/${id}/stop`, { user: "ada" })).toEqual({ stopped: true });
    const { events } = await stream;
    expect(stopped).toEqual(["ada"]);
    expect(events.at(-2)).toMatchObject({ type: "reply", text: "Stopped." });
    expect(events.at(-1)).toMatchObject({ type: "turn_ended", status: "interrupted" });

    const failing = readEvents(`${base}/sessions/${id}/events`, ended);
    await Bun.sleep(20);
    await post(`/sessions/${id}/messages`, { text: "doomed" });
    await finish("doomed", "fail");
    expect((await failing).events.at(-1)).toMatchObject({ type: "turn_ended", status: "failed" });
  });

  test("rejects bad messages and a full queue", async () => {
    const { base, call, post } = setup({ maxQueue: 1 });
    const { id } = await post("/sessions");
    const path = `/sessions/${id}/messages`;
    expect((await call("POST", "/sessions/nope/messages", { text: "hi" })).status).toBe(404);
    const empty = await call("POST", path, { text: "   " });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "text is required" });
    expect((await call("POST", path, { text: "hi", user: "a b" })).status).toBe(400);
    const notJson = await fetch(base + path, { method: "POST", body: "{" });
    expect(notJson.status).toBe(415);
    const broken = await fetch(base + path, {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" },
    });
    expect(broken.status).toBe(400);

    expect((await call("POST", path, { text: "running" })).status).toBe(202);
    expect(await post(path, { text: "waiting" })).toMatchObject({ status: "queued", position: 1 });
    const full = await call("POST", path, { text: "one too many" });
    expect(full.status).toBe(429);
  });
});

describe("the API channel", () => {
  test("a scheduled result opens a session of its own", async () => {
    const { get, hub, apiSessions } = setup();
    const chat = createApiChat({ hub, sessions: apiSessions });
    expect(chat.channel.owns("api:chat")).toBe(true);
    expect(chat.channel.owns("C123")).toBe(false);
    expect(await chat.channel.ensureChannel("anything")).toBe("api:chat");
    const reply = chat.channel.replyTo({ channel: "api:chat", ts: "", startsThread: true });
    const id = await reply.post("⏰ **Nightly check**\n\nAll green.");
    expect(await reply.post("More details.")).toBe(id);
    const sessions = await get("/sessions");
    expect(sessions).toMatchObject([{ id, title: "⏰ Nightly check", status: "idle" }]);
  });

  test("a message from before a restart is announced when its turn starts", async () => {
    const { hub, apiSessions } = setup();
    const chat = createApiChat({ hub, sessions: apiSessions });
    const session = apiSessions.create();
    const message: QueuedMessage = {
      id: 1,
      conversationKey: apiConversationKey(session.id),
      channel: "api:chat",
      ts: "m1",
      threadTs: session.id,
      user: "web",
      text: "still here",
      scheduleId: null,
      mode: "direct",
      files: [],
    };
    const seen: LiveEvent[] = [];
    hub.subscribe(session.id, undefined, (e) => seen.push(e));
    await chat.observe(async () => {})(message, new AbortController().signal);
    expect(types(seen)).toEqual(["user_message", "turn_started", "turn_ended"]);
    expect(seen[0]).toMatchObject({ text: "still here", user: "web" });
    // A scheduled run and other channels' turns are left alone.
    await chat.observe(async () => {})({ ...message, scheduleId: 3 }, new AbortController().signal);
    await chat.observe(async () => {})({ ...message, channel: "C1" }, new AbortController().signal);
    expect(seen).toHaveLength(3);
  });
});
