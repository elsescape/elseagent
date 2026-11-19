import type { LiveEvent, SessionEvent } from "../api/events.ts";

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

const TOKEN_KEY = "elseagent.token";
export const savedToken = () => localStorage.getItem(TOKEN_KEY) ?? "";
export const saveToken = (token: string) => localStorage.setItem(TOKEN_KEY, token);

const headers = (): Record<string, string> => {
  const token = savedToken();
  return token ? { authorization: `Bearer ${token}` } : {};
};

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...headers(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw new Unauthorized();
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${method} ${path} failed (${res.status})`);
  return data as T;
}

export const api = {
  status: () => request<AgentStatus>("GET", "/status"),
  sessions: () => request<Session[]>("GET", "/sessions"),
  session: (id: string) => request<SessionView>("GET", `/sessions/${id}`),
  create: () => request<Session>("POST", "/sessions", {}),
  rename: (id: string, title: string) => request<Session>("PATCH", `/sessions/${id}`, { title }),
  remove: (id: string) => request<void>("DELETE", `/sessions/${id}`),
  send: (id: string, text: string) =>
    request<unknown>("POST", `/sessions/${id}/messages`, { text }),
  stop: (id: string) => request<unknown>("POST", `/sessions/${id}/stop`, {}),
};

const RETRY_MS = 1500;

/**
 * Follow a session's events after `cursor` until `signal` aborts, reconnecting where the
 * stream stopped when the connection drops. (`EventSource` can't send the bearer token.)
 */
export async function followEvents(
  id: string,
  cursor: string,
  onEvent: (event: LiveEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let after = cursor;
  while (!signal.aborted) {
    try {
      const res = await fetch(`/api/sessions/${id}/events?after=${encodeURIComponent(after)}`, {
        headers: headers(),
        signal,
      });
      if (res.status === 401 || res.status === 404 || !res.body) return;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let split = buffer.indexOf("\n\n");
        for (; split !== -1; split = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!data) continue; // a comment that keeps the connection open
          after = /^id: (.*)$/m.exec(block)?.[1] ?? after;
          onEvent(JSON.parse(data));
        }
      }
    } catch {
      // dropped; try again below
    }
    if (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}
