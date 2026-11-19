import type { ThreadItem } from "@openai/codex-sdk";
import type { EventFile, SessionEvent, TurnStatus } from "../api/events.ts";

/** What the chat shows, in order, built from a session's events. */
export type Entry =
  | { kind: "user"; key: string; text: string; files: EventFile[] }
  | { kind: "item"; key: string; item: ThreadItem; done: boolean }
  | { kind: "reply"; key: string; text: string; choices: string[]; files: EventFile[] }
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
        entries.push({ kind: "user", key, text: event.text, files: event.files });
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
          files: event.files,
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

type Step = Extract<Entry, { kind: "item" }>;

/** What the chat renders: an entry, or the steps Codex took in a row, folded into one block. */
export type Block =
  | Exclude<Entry, Step>
  | { kind: "steps"; key: string; steps: Step[] /** Still being added to. */; active: boolean };

/** Fold each run of consecutive Codex items into one block. */
export function groupSteps(entries: readonly Entry[], busy: boolean): Block[] {
  const blocks: Block[] = [];
  for (const entry of entries) {
    const last = blocks.at(-1);
    if (entry.kind !== "item") blocks.push(entry);
    else if (last?.kind === "steps") last.steps.push(entry);
    else blocks.push({ kind: "steps", key: `steps:${entry.key}`, steps: [entry], active: false });
  }
  const last = blocks.at(-1);
  if (busy && last?.kind === "steps") last.active = true;
  return blocks;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A line for a folded block of steps: "Ran 2 commands · edited 1 file". */
export function summarizeSteps(steps: readonly Step[]): string {
  const count = (type: ThreadItem["type"]) => steps.filter((s) => s.item.type === type).length;
  const parts = [
    [count("command_execution"), (n: number) => `ran ${plural(n, "command")}`],
    [count("file_change"), (n: number) => `made ${plural(n, "edit")}`],
    [count("mcp_tool_call"), (n: number) => `used ${plural(n, "tool")}`],
    [count("web_search"), (n: number) => `searched ${plural(n, "time")}`],
  ] as const;
  const text = parts
    .filter(([n]) => n > 0)
    .map(([n, say]) => say(n))
    .join(" · ");
  const line = text || plural(steps.length, "step");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** Sessions under a heading for when they were last active. */
export function groupByDay<T extends { updatedAt: number }>(
  sessions: readonly T[],
  now = Date.now(),
): { label: string; sessions: T[] }[] {
  const today = new Date(now).setHours(0, 0, 0, 0);
  const DAY = 24 * 60 * 60 * 1000;
  const groups = [
    { label: "Today", from: today },
    { label: "Yesterday", from: today - DAY },
    { label: "Previous 7 days", from: today - 7 * DAY },
    { label: "Older", from: Number.NEGATIVE_INFINITY },
  ].map((g) => ({ ...g, sessions: [] as T[] }));
  for (const session of sessions) {
    groups.find((g) => session.updatedAt >= g.from)?.sessions.push(session);
  }
  return groups
    .filter((g) => g.sessions.length > 0)
    .map(({ label, sessions }) => ({ label, sessions }));
}
