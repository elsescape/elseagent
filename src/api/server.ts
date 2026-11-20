import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { BunRequest, Server } from "bun";
import { z } from "zod";
import { type Admin, AdminError } from "../agent/admin.ts";
import {
  attachmentsDir,
  fileWithin,
  freePath,
  MAX_ATTACHMENT_BYTES,
  safeFileName,
} from "../agent/files.ts";
import type { Scheduler } from "../agent/scheduler.ts";
import { USAGE_GROUPS } from "../agent/usage.ts";
import type { Attachment } from "../channels/types.ts";
import type { ApiSession, ApiSessionStore } from "../state/api-sessions.ts";
import type { MessageQueue, SessionStore } from "../state/index.ts";
import type { MemoryStore } from "../state/memory.ts";
import { TODO_FILTERS, type TodoStore } from "../state/todos.ts";
import { formatSize } from "../util/text.ts";
import { API_CHAT, announce, apiConversationKey, eventFile, titleFrom } from "./channel.ts";
import type { EventHub, LiveEvent, SessionEvent, SessionStatus, UploadedFile } from "./events.ts";
import { type HistoryOptions, threadHistory } from "./history.ts";

/** Who a message is from when the client doesn't say. */
const DEFAULT_USER = "api";
const MAX_MESSAGE_CHARS = 100_000;
/** Room for the longest message in any encoding; a JSON body is never larger. */
const MAX_JSON_BYTES = 1024 * 1024;
/** Files attached to one message, and uploaded in one request. */
const MAX_FILES = 10;
/** An upload request: its files, and some room for the multipart framing. */
const MAX_UPLOAD_BYTES = MAX_FILES * MAX_ATTACHMENT_BYTES + MAX_JSON_BYTES;
const MAX_TITLE_CHARS = 200;
const PING_MS = 15_000;

export interface ApiServerDeps {
  host: string;
  /** 0 picks a free port (tests). */
  port: number;
  /** Requests must carry it as a bearer token. Without one, anyone who can connect is let in. */
  token?: string;
  /** Codex's working directory: uploads are saved in it, and its files can be downloaded. */
  workspace: string;
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
  message: z
    .object({
      text: z.string().trim().max(MAX_MESSAGE_CHARS).default(""),
      // Paths of files uploaded to the session, as the upload returned them.
      files: z.array(z.string().min(1)).max(MAX_FILES, `at most ${MAX_FILES} files`).default([]),
      user: userId.optional(),
    })
    .refine((m) => m.text || m.files.length, "text or files is required"),
  stop: z.object({ user: userId.optional() }),
};

/** The JSON body of a request, checked against `schema`. An empty body is `{}`. */
async function readBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  // Uploads raise the server's own limit far above what JSON needs, so count here, and stop
  // reading as soon as it is too much.
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for await (const chunk of req.body ?? []) {
    bytes += chunk.byteLength;
    if (bytes > MAX_JSON_BYTES) throw new HttpError(413, "the body is too large");
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
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

/** How many items a list returns: `?limit=`, at most 500. */
const limit = (req: Request, fallback: number) =>
  intParam(new URL(req.url), "limit", fallback, 500);

/** A file's media type from its name, without parameters ("text/plain", not "…;charset=utf-8"). */
const mimeOf = (path: string) => Bun.file(path).type.split(";")[0];

const sse = (event: LiveEvent, epoch: string) =>
  `id: ${epoch}:${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;

/**
 * Serve the HTTP API under `/api`: the agent's state for a dashboard, and chat sessions for a
 * chat UI (create one, post messages, stream the turn as server-sent events).
 */
export function startApiServer(deps: ApiServerDeps): ApiEndpoint {
  const { admin, scheduler, queue, sessions, apiSessions, hub, token, workspace } = deps;
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
      if (token) {
        if (!sameSecret(req.headers.get("authorization") ?? "", `Bearer ${token}`)) {
          return error(401, "missing or wrong bearer token");
        }
      } else {
        // Nothing else stops a page of another site, open in a browser on this machine, from
        // driving the agent. (With a token it can't: it doesn't have it.)
        const origin = req.headers.get("origin");
        if (origin && URL.parse(origin)?.host !== req.headers.get("host")) {
          return error(403, "cross-origin requests are not allowed");
        }
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
    return (id: string): SessionStatus => {
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

  /** A route under `/api/sessions/:id`: the handler gets the session and its conversation key. */
  const withSession = <P extends string>(
    handler: (
      at: { session: ApiSession; key: string },
      req: BunRequest<P>,
      server: Server<undefined>,
    ) => Response | Promise<Response>,
  ): Handler<P> =>
    guard((req, server) => {
      const session = find((req.params as Record<string, string>).id ?? "");
      return handler({ session, key: apiConversationKey(session.id) }, req, server);
    });

  const server = Bun.serve({
    hostname: deps.host,
    port: deps.port,
    maxRequestBodySize: MAX_UPLOAD_BYTES,
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
        GET: guard((req) => json(admin.listQueue(limit(req, 50)))),
      },
      "/api/conversations": {
        GET: guard((req) => json(admin.listSessions(limit(req, 50)))),
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
          const filter = TODO_FILTERS.find((s) => s === wanted);
          if (!filter) throw new HttpError(400, `unknown status ${wanted}`);
          return json(deps.todos.list(filter, limit(req, 100)));
        }),
      },
      "/api/memories": {
        GET: guard((req) => {
          const url = new URL(req.url);
          const query = url.searchParams.get("q") ?? undefined;
          return json(deps.memories.search(query, limit(req, 100)));
        }),
      },

      "/api/sessions": {
        GET: guard((req) => {
          const statusOf = busyConversations();
          const list = apiSessions.list(limit(req, 100));
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
        GET: withSession(async ({ session, key }) => {
          // Taken together, before anything is awaited, so no event falls between them.
          const cursor = hub.cursor;
          const live = hub.live(session.id);
          // The turn in progress is in `live`; keep whatever Codex has written of it out.
          const before = hub.runningSince(session.id) ?? now();
          const threads = sessions.threadsOf(key);
          return json({
            session: describe(session),
            history: await history(threads, { before }),
            live,
            cursor,
          });
        }),
        PATCH: withSession(async ({ session }, req) => {
          const body = await readBody(req, bodies.renameSession);
          return json(describe(apiSessions.rename(session.id, body.title) ?? session));
        }),
        DELETE: withSession(({ session, key }) => {
          if (busyConversations()(session.id) !== "idle") {
            throw new HttpError(409, "a turn is queued or running in this session; stop it first");
          }
          // Its Codex threads stay tracked, so cleanup deletes them from Codex later.
          sessions.forget(key);
          apiSessions.delete(session.id);
          hub.drop(session.id);
          return new Response(null, { status: 204 });
        }),
      },
      "/api/sessions/:id/messages": {
        POST: withSession(async ({ session, key }, req) => {
          const body = await readBody(req, bodies.message);
          const { text, user = DEFAULT_USER } = body;
          // Only what was uploaded to this session: already in place, nothing to download.
          const uploads = attachmentsDir(workspace, key);
          const attached: Attachment[] = [];
          for (const given of body.files) {
            const path = resolve(workspace, given);
            if (!(await fileWithin(uploads, path))) {
              throw new HttpError(400, `not a file uploaded to this session: ${given}`);
            }
            const file = Bun.file(path);
            attached.push({
              name: basename(path),
              mimetype: mimeOf(path),
              size: file.size,
              ref: path,
              path,
            });
          }
          const messageId = crypto.randomUUID();
          const result = scheduler.submit({
            conversationKey: key,
            channel: API_CHAT,
            ts: messageId,
            threadTs: session.id,
            user,
            text,
            files: attached,
          });
          if (result.status === "rejected") {
            throw new HttpError(429, "the agent's queue is full; try again in a while");
          }
          announce(hub, workspace, session.id, { ts: messageId, text, user, files: attached });
          apiSessions.touch(session.id, titleFrom(text || (attached[0]?.name ?? "")));
          return json({ messageId, ...result }, 202);
        }),
      },
      "/api/sessions/:id/files": {
        /**
         * Upload files for the session's next message (multipart form data, one `file` field
         * each). They are saved in the workspace; pass the returned paths as the message's
         * `files`.
         */
        POST: withSession(async ({ key }, req) => {
          const form = await req.formData().catch(() => {
            throw new HttpError(400, "send the files as multipart/form-data, in `file` fields");
          });
          const uploads = form.getAll("file").filter((value) => value instanceof File);
          if (uploads.length === 0) throw new HttpError(400, "no `file` field in the form");
          if (uploads.length > MAX_FILES) {
            throw new HttpError(400, `at most ${MAX_FILES} files at a time`);
          }
          for (const upload of uploads) {
            if (upload.size === 0) throw new HttpError(400, `${upload.name} is empty`);
            if (upload.size > MAX_ATTACHMENT_BYTES) {
              const limit = formatSize(MAX_ATTACHMENT_BYTES);
              throw new HttpError(413, `${upload.name} is larger than ${limit}`);
            }
          }
          const dir = attachmentsDir(workspace, key);
          await mkdir(dir, { recursive: true });
          const saved: UploadedFile[] = [];
          for (const upload of uploads) {
            const path = await freePath(dir, safeFileName(upload.name));
            await Bun.write(path, upload);
            saved.push({
              ...eventFile(path, workspace),
              size: upload.size,
              mimetype: mimeOf(path),
            });
          }
          return json(saved, 201);
        }),
      },
      "/api/files": {
        /**
         * Download a file of the workspace: one the agent sent with a reply, or an upload.
         * `path` is as events give it. Always a download, never a page: what the agent wrote
         * must not run in the browser with this origin's access to the API.
         */
        GET: guard(async (req) => {
          const path = new URL(req.url).searchParams.get("path");
          if (!path) throw new HttpError(400, "path is required");
          const target = await fileWithin(workspace, path);
          if (!target) throw new HttpError(404, `no file ${path} in the workspace`);
          const file = Bun.file(target);
          return new Response(file, {
            headers: {
              "content-type": file.type,
              "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(basename(target))}`,
              "x-content-type-options": "nosniff",
              "content-security-policy": "sandbox",
              "cache-control": "private, no-cache",
            },
          });
        }),
      },
      "/api/sessions/:id/stop": {
        POST: withSession(async ({ key }, req) => {
          const { user = DEFAULT_USER } = await readBody(req, bodies.stop);
          return json({ stopped: scheduler.cancel(key, user) });
        }),
      },
      "/api/sessions/:id/events": {
        /**
         * The session's events as they happen (server-sent events, one JSON event per `data`).
         * `Last-Event-ID` or `?after=` (a cursor) resumes after that event; without one the
         * stream starts with the turns in progress.
         */
        GET: withSession(({ session }, req, server) => {
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

  const origin = `http://${server.hostname}:${server.port}`;
  return {
    url: `${origin}/api`,
    stop: () => server.stop(true),
  };
}
