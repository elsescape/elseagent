import type { LiveEvent, SessionEvent, SessionStatus, UploadedFile } from "../api/events.ts";
import type { ApiSession } from "../state/api-sessions.ts";

/** The browser's side of the HTTP API (see src/api/server.ts). */

/** A session as the API lists it. */
export type Session = ApiSession & { status: SessionStatus };

/** What a session is called on the page; it has no title until its first message. */
export const titleOf = (session: Session | undefined) => session?.title || "New chat";

export interface SessionView {
  session: Session;
  history: SessionEvent[];
  live: LiveEvent[];
  cursor: string;
}

export interface AgentStatus {
  version: string;
  model: string | null;
  running: unknown[];
  queued: number;
}

/** The API wants a token, or the saved one is wrong. */
export class Unauthorized extends Error {}
/** The session is gone (deleted, or it was another agent's). */
export class NotFound extends Error {}

const TOKEN_KEY = "elseagent.token";
const savedToken = () => localStorage.getItem(TOKEN_KEY) ?? "";
export const saveToken = (token: string) => localStorage.setItem(TOKEN_KEY, token);

const headers = (): Record<string, string> => {
  const token = savedToken();
  return token ? { authorization: `Bearer ${token}` } : {};
};

/** Call the API with the saved token. A missing session or a refused token is thrown. */
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`/api${path}`, { ...init, headers: { ...headers(), ...init.headers } });
  if (res.status === 401) throw new Unauthorized();
  if (res.status === 404) throw new NotFound();
  return res;
}

/** The JSON of a response, or the error it reports. */
async function json<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `the request failed (${res.status})`);
  return data as T;
}

const request = async <T>(method: string, path: string, body?: unknown): Promise<T> =>
  json(
    await call(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

export const api = {
  status: () => request<AgentStatus>("GET", "/status"),
  sessions: () => request<Session[]>("GET", "/sessions"),
  session: (id: string) => request<SessionView>("GET", `/sessions/${id}`),
  create: () => request<Session>("POST", "/sessions", {}),
  rename: (id: string, title: string) => request<Session>("PATCH", `/sessions/${id}`, { title }),
  remove: (id: string) => request<void>("DELETE", `/sessions/${id}`),
  send: (id: string, text: string, files: string[] = []) =>
    request<unknown>("POST", `/sessions/${id}/messages`, { text, files }),
  stop: (id: string) => request<unknown>("POST", `/sessions/${id}/stop`, {}),
  /** Save a file in the session's attachments; its path goes with the next message. */
  upload: async (id: string, file: File): Promise<UploadedFile> => {
    const body = new FormData();
    body.append("file", file);
    const [saved] = await json<UploadedFile[]>(
      await call(`/sessions/${id}/files`, { method: "POST", body }),
    );
    if (!saved) throw new Error("the upload was not saved");
    return saved;
  },
  /** A workspace file's content. (A link can't carry the bearer token; `fetch` can.) */
  file: async (path: string): Promise<Blob> => {
    const res = await call(`/files?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new NotFound();
    return res.blob();
  },
};

/**
 * Deliver a session's events after `cursor` until the stream ends: `signal` aborted, or the
 * connection dropped (the agent restarted, the network went). The caller then loads the
 * session again, since a cursor does not outlive the agent's process.
 * (`EventSource` can't send the bearer token, hence `fetch`.)
 */
export async function followEvents(
  id: string,
  cursor: string,
  onEvent: (event: LiveEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await call(`/sessions/${id}/events?after=${encodeURIComponent(cursor)}`, { signal });
  if (!res.ok || !res.body) throw new Error(`the event stream failed (${res.status})`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let split = buffer.indexOf("\n\n");
    for (; split !== -1; split = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (data) onEvent(JSON.parse(data)); // anything else is a comment keeping the stream open
    }
  }
}
