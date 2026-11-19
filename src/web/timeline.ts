import type { ThreadItem } from "@openai/codex-sdk";
import type { SessionEvent, TurnStatus } from "../api/events.ts";

/** What the chat shows, in order, built from a session's events. */
export type Entry =
  | { kind: "user"; key: string; text: string }
  | { kind: "item"; key: string; item: ThreadItem; done: boolean }
  | { kind: "reply"; key: string; text: string; choices: string[]; files: string[] }
  | { kind: "ended"; key: string; status: Exclude<TurnStatus, "completed"> };

export interface Timeline {
  entries: Entry[];
  /** What the agent is doing right now ("is running `bun test`…"); empty when idle. */
  status: string;
  /** Whether a turn is queued or running. */
  busy: boolean;
}

/** Codex's final message is the reply as JSON; the `reply` event shows it instead. */
function isStructuredReply(text: string): boolean {
  if (!text.trimStart().startsWith("{")) return false;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.message === "string" && "reply" in parsed;
  } catch {
    return false;
  }
}

export function buildTimeline(events: readonly SessionEvent[]): Timeline {
  const entries: Entry[] = [];
  /** Where each Codex item is, so its later events update it in place. */
  const items = new Map<string, number>();
  const open = new Set<string>();
  let status = "";
  events.forEach((event, i) => {
    const key = `${event.messageId}:${i}`;
    switch (event.type) {
      case "user_message":
        open.add(event.messageId);
        entries.push({ kind: "user", key, text: event.text });
        break;
      case "turn_started":
        open.add(event.messageId);
        break;
      case "status":
        status = event.text;
        break;
      case "codex": {
        const codex = event.event;
        if (
          codex.type !== "item.started" &&
          codex.type !== "item.updated" &&
          codex.type !== "item.completed"
        ) {
          break;
        }
        const { item } = codex;
        if (item.type === "agent_message" && isStructuredReply(item.text)) break;
        if ((item.type === "reasoning" || item.type === "agent_message") && !item.text.trim())
          break;
        const id = `${event.messageId}:${item.id}`;
        const entry: Entry = { kind: "item", key: id, item, done: codex.type === "item.completed" };
        const at = items.get(id);
        if (at === undefined) items.set(id, entries.push(entry) - 1);
        else entries[at] = entry;
        break;
      }
      case "reply":
        entries.push({
          kind: "reply",
          key,
          text: event.text,
          choices: event.choices,
          files: event.files.map((f) => f.path),
        });
        break;
      case "turn_ended":
        open.delete(event.messageId);
        status = "";
        if (event.status !== "completed")
          entries.push({ kind: "ended", key, status: event.status });
        break;
    }
  });
  return { entries, status: open.size ? status : "", busy: open.size > 0 };
}
