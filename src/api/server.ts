import { createHash, timingSafeEqual } from "node:crypto";
import type { BunRequest, Server } from "bun";
import { z } from "zod";
import { type Admin, AdminError } from "../agent/admin.ts";
import type { Scheduler } from "../agent/scheduler.ts";
import { USAGE_GROUPS } from "../agent/usage.ts";
import type { ApiSession, ApiSessionStore } from "../state/api-sessions.ts";
import type { MessageQueue, SessionStore } from "../state/index.ts";
import type { MemoryStore } from "../state/memory.ts";
import { TODO_STATUSES, type TodoStore } from "../state/todos.ts";
import { API_CHAT, apiConversationKey, titleFrom } from "./channel.ts";
import type { EventHub, LiveEvent, SessionEvent } from "./events.ts";
import { type HistoryOptions, threadHistory } from "./history.ts";

/** Who a message is from when the client doesn't say. */
export const DEFAULT_USER = "web";
const MAX_MESSAGE_CHARS = 100_000;
const MAX_TITLE_CHARS = 200;
const PING_MS = 15_000;

export interface ApiServerDeps {
  host: string;
  /** 0 picks a free port (tests). */
  port: number;
  /** Requests must carry it as a bearer token. Without one, anyone who can connect is let in. */
  token?: string;
  admin: Pick<Admin, "status" | "listQueue" | "listSessions" | "scheduleList" | "usage">;
  scheduler: Pick<Scheduler, "submit" | "cancel" | "runningTurns">;
  queue: Pick<MessageQueue, "conversations">;
  sessions: Pick<SessionStore, "threadsOf" | "forget">;
  apiSessions: ApiSessionStore;
  hub: EventHub;
  todos: Pick<TodoStore, "list">;
  memories: Pick<MemoryStore, "search">;
  /** What `/api/status` says about the agent besides its live state. */
  info: Record<string, unknown>;
  /** Finished turns of Codex threads (tests pass a fake). */
  history?: (threadIds: string[], options: HistoryOptions) => Promise<SessionEvent[]>;
  now?: () => number;
}

export interface ApiEndpoint {
  /** Base URL of the API, e.g. `http://127.0.0.1:2923/api`. */
  url: string;
  stop(): Promise<void>;
}

/** An error answered with its status and message. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const error = (status: number, message: string) => json({ error: message }, status);

const digest = (value: string) => createHash("sha256").update(value).digest();
/** Compare without leaking, through timing, how much of the token matched. */
const sameSecret = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

const userId = z
  .string()
  .trim()
  .regex(/^[\w.@-]{1,64}$/, "user must be 1 to 64 letters, digits, or . _ @ -");
const title = z.string().trim().max(MAX_TITLE_CHARS);
const bodies = {
  createSession: z.object({ title: title.optional() }),
  renameSession: z.object({ title }),
  message: z.object({
    text: z.string().trim().min(1, "text is required").max(MAX_MESSAGE_CHARS),
    user: userId.optional(),
  }),
  stop: z.object({ user: userId.optional() }),
};

/** The JSON body of a request, checked against `schema`. An empty body is `{}`. */
async function readBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  const text = await req.text();
  let raw: unknown = {};
  if (text.trim()) {
    // A cross-site form can post text/plain without a preflight; JSON can't.
    if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new HttpError(415, "send the body as application/json");
    }
    try {
      raw = JSON.parse(text);
    } catch {
      throw new HttpError(400, "the body is not valid JSON");
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues.map((i) => i.message).join("; "));
  }
  return parsed.data;
}

/** A whole number from the query string, within bounds; `fallback` when absent. */
function intParam(url: URL, name: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `${name} must be a whole number`);
  return Math.min(n, max);
}

const sse = (event: LiveEvent, epoch: string) =>
  `id: ${epoch}:${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;

/**
 * Serve the HTTP API under `/api`: the agent's state for a dashboard, and chat sessions for a
 * chat UI (create one, post messages, stream the turn as server-sent events).
 */
export function startApiServer(deps: ApiServerDeps): ApiEndpoint {
  const { admin, scheduler, queue, sessions, apiSessions, hub, token } = deps;
  const now = deps.now ?? Date.now;
  const history = deps.history ?? threadHistory;
  const startedAt = now();

  type Handler<P extends string> = (
    req: BunRequest<P>,
    server: Server<undefined>,
  ) => Response | Promise<Response>;

  /** Check who is calling, then answer; errors become JSON. */
  const guard =
    <P extends string>(handler: Handler<P>): Handler<P> =>
    async (req, server) => {
      // A browser page from another site may not drive the agent, token or not.
      const origin = req.headers.get("origin");
      if (origin && URL.parse(origin)?.host !== req.headers.get("host")) {
        return error(403, "cross-origin requests are not allowed");
      }
      if (token && !sameSecret(req.headers.get("authorization") ?? "", `Bearer ${token}`)) {
        return error(401, "missing or wrong bearer token");
      }
      try {
        return await handler(req, server);
      } catch (err) {
        if (err instanceof HttpError) return error(err.status, err.message);
        if (err instanceof AdminError) return error(400, err.message);
        console.warn(`api: ${req.method} ${new URL(req.url).pathname} failed: ${err}`);
        return error(500, "internal error");
      }
    };

  const busyConversations = () => {
    const running = new Set(scheduler.runningTurns().map((t) => t.message.conversationKey));
    const waiting = new Set(queue.conversations());
    return (id: string): "running" | "queued" | "idle" => {
      const key = apiConversationKey(id);
      return running.has(key) ? "running" : waiting.has(key) ? "queued" : "idle";
    };
  };
  const describe = (session: ApiSession, statusOf = busyConversations()) => ({
    ...session,
    status: statusOf(session.id),
  });
  const find = (id: string): ApiSession => {
    const session = apiSessions.get(id);
    if (!session) throw new HttpError(404, `no session ${id}`);
    return session;
  };

  const server = Bun.serve({
    hostname: deps.host,
    port: deps.port,
    routes: {
      "/api/status": {
        GET: guard(() =>
          json({
            ...deps.info,
            startedAt: new Date(startedAt).toISOString(),
            uptimeSeconds: Math.round((now() - startedAt) / 1000),
            ...admin.status(),
          }),
        ),
      },
      "/api/queue": {
        GET: guard((req) => json(admin.listQueue(intParam(new URL(req.url), "limit", 50, 500)))),
      },
      "/api/conversations": {
        GET: guard((req) => json(admin.listSessions(intParam(new URL(req.url), "limit", 50, 500)))),
      },
      "/api/schedules": { GET: guard(() => json(admin.scheduleList())) },
      "/api/usage": {
        GET: guard((req) => {
          const url = new URL(req.url);
          const groupBy = url.searchParams.get("groupBy") ?? undefined;
          const group = USAGE_GROUPS.find((g) => g === groupBy);
          if (groupBy && !group) {
            throw new HttpError(400, `groupBy must be one of ${USAGE_GROUPS.join(", ")}`);
          }
          return json(
            admin.usage({
              since: url.searchParams.get("since") ?? undefined,
              until: url.searchParams.get("until") ?? undefined,
              days: url.searchParams.has("days") ? intParam(url, "days", 7, 3650) : undefined,
              groupBy: group,
            }),
          );
        }),
      },
      "/api/todos": {
        GET: guard((req) => {
          const url = new URL(req.url);
          const wanted = url.searchParams.get("status") ?? "active";
          const filter = ([...TODO_STATUSES, "active", "all"] as const).find((s) => s === wanted);
          if (!filter) throw new HttpError(400, `unknown status ${wanted}`);
          return json(deps.todos.list(filter, intParam(url, "limit", 100, 500)));
        }),
      },
      "/api/memories": {
        GET: guard((req) => {
          const url = new URL(req.url);
          const query = url.searchParams.get("q") ?? undefined;
          return json(deps.memories.search(query, intParam(url, "limit", 100, 500)));
        }),
      },

      "/api/sessions": {
        GET: guard((req) => {
          const statusOf = busyConversations();
          const list = apiSessions.list(intParam(new URL(req.url), "limit", 100, 500));
          return json(list.map((s) => describe(s, statusOf)));
        }),
        POST: guard(async (req) => {
          const body = await readBody(req, bodies.createSession);
          return json(describe(apiSessions.create(body.title)), 201);
        }),
      },
      "/api/sessions/:id": {
        /**
         * The session as a chat UI first shows it: `history` (finished turns, from Codex) and
         * `live` (turns queued or running). Stream what follows from `cursor`.
         */
        GET: guard(async (req) => {
          const session = find(req.params.id);
          // Taken together, before anything is awaited, so no event falls between them.
          const cursor = hub.cursor;
          const live = hub.live(session.id);
          // The turn in progress is in `live`; keep whatever Codex has written of it out.
          const before = live.find((e) => e.type === "turn_started")?.at ?? now();
          const threads = sessions.threadsOf(apiConversationKey(session.id));
          return json({
            session: describe(session),
            history: await history(threads, { before }),
            live,
            cursor,
          });
        }),
        PATCH: guard(async (req) => {
          const session = find(req.params.id);
          const body = await readBody(req, bodies.renameSession);
          return json(describe(apiSessions.rename(session.id, body.title) ?? session));
        }),
        DELETE: guard((req) => {
          const session = find(req.params.id);
          if (busyConversations()(session.id) !== "idle") {
            throw new HttpError(409, "a turn is queued or running in this session; stop it first");
          }
          // Its Codex threads stay tracked, so cleanup deletes them from Codex later.
          sessions.forget(apiConversationKey(session.id));
          apiSessions.delete(session.id);
          hub.drop(session.id);
          return new Response(null, { status: 204 });
        }),
      },
      "/api/sessions/:id/messages": {
        POST: guard(async (req) => {
          const session = find(req.params.id);
          const { text, user = DEFAULT_USER } = await readBody(req, bodies.message);
          const messageId = crypto.randomUUID();
          const result = scheduler.submit({
            conversationKey: apiConversationKey(session.id),
            channel: API_CHAT,
            ts: messageId,
            threadTs: session.id,
            user,
            text,
          });
          if (result.status === "rejected") {
            throw new HttpError(429, "the agent's queue is full; try again in a while");
          }
          // A turn that started right away has announced the message itself.
          if (!hub.has(session.id, messageId)) {
            hub.publish(session.id, messageId, { type: "user_message", text, user });
          }
          apiSessions.touch(session.id, titleFrom(text));
          return json({ messageId, ...result }, 202);
        }),
      },
      "/api/sessions/:id/stop": {
        POST: guard(async (req) => {
          const session = find(req.params.id);
          const { user = DEFAULT_USER } = await readBody(req, bodies.stop);
          return json({ stopped: scheduler.cancel(apiConversationKey(session.id), user) });
        }),
      },
      "/api/sessions/:id/events": {
        /**
         * The session's events as they happen (server-sent events, one JSON event per `data`).
         * `Last-Event-ID` or `?after=` (a cursor) resumes after that event; without one the
         * stream starts with the turns in progress.
         */
        GET: guard((req, server) => {
          const session = find(req.params.id);
          const after =
            req.headers.get("last-event-id") ??
            new URL(req.url).searchParams.get("after") ??
            undefined;
          server.timeout(req, 0); // the stream stays open while nothing happens
          const encoder = new TextEncoder();
          let close = () => {};
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const send = (chunk: string) => {
                try {
                  controller.enqueue(encoder.encode(chunk));
                } catch {
                  close(); // the client is gone
                }
              };
              send(": connected\n\n");
              const unsubscribe = hub.subscribe(session.id, after, (e) => send(sse(e, hub.epoch)));
              const ping = setInterval(() => send(": ping\n\n"), PING_MS);
              close = () => {
                unsubscribe();
                clearInterval(ping);
              };
              req.signal.addEventListener("abort", () => close(), { once: true });
            },
            cancel: () => close(),
          });
          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              "x-accel-buffering": "no",
            },
          });
        }),
      },
    },
    fetch: () => error(404, "not found"),
  });

  return {
    url: `http://${server.hostname}:${server.port}/api`,
    stop: () => server.stop(true),
  };
}
