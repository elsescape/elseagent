import type { EventFile, LiveEvent, SessionEvent } from "../api/events.ts";

/** The browser's side of the HTTP API (see src/api/server.ts). */

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: "idle" | "queued" | "running";
}

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

/** The JSON of a response, or the error it reports. */
async function check<T>(res: Response): Promise<T> {
  if (res.status === 401) throw new Unauthorized();
  if (res.status === 404) throw new NotFound();
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `the request failed (${res.status})`);
  return data as T;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  return check(
    await fetch(`/api${path}`, {
      method,
      headers: {
        ...headers(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

export const api = {
  status: () => request<AgentStatus>("GET", "/status"),
  sessions: () => request<Session[]>("GET", "/sessions"),
  session: (id: string) => request<SessionView>("GET", `/sessions/${id}`),
  create: () => request<Session>("POST", "/sessions", {}),
  rename: (id: string, title: string) => request<Session>("PATCH", `/sessions/${id}`, { title }),
  remove: (id: string) => request<void>("DELETE", `/sessions/${id}`),
  send: (id: string, text: string, files: string[] = []) =>
    request<unknown>("POST", `/sessions/${id}/messages`, { text, files }),
  /** Save files in the session's attachments; their paths go with the next message. */
  upload: async (id: string, files: File[]): Promise<EventFile[]> => {
    const body = new FormData();
    for (const file of files) body.append("file", file);
    return check(
      await fetch(`/api/sessions/${id}/files`, { method: "POST", headers: headers(), body }),
    );
  },
  /** A workspace file's content. (A link can't carry the bearer token; `fetch` can.) */
  file: async (path: string): Promise<Blob> => {
    const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`, { headers: headers() });
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok) throw new NotFound();
    return res.blob();
  },
  stop: (id: string) => request<unknown>("POST", `/sessions/${id}/stop`, {}),
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
  const res = await fetch(`/api/sessions/${id}/events?after=${encodeURIComponent(cursor)}`, {
    headers: headers(),
    signal,
  });
  if (res.status === 401) throw new Unauthorized();
  if (res.status === 404) throw new NotFound();
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
