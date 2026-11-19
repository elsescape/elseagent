import { basename } from "node:path";
import type { ThreadItem } from "@openai/codex-sdk";
import { parseReply } from "../agent/reply.ts";
import { codexHome, rolloutPath } from "../codex.ts";
import type { EventFile, SessionEvent, SessionEventBody } from "./events.ts";

/**
 * A session's finished turns, read back from Codex's own history: the rollout file of each Codex
 * thread (`rollout-<date>-<thread id>.jsonl` under `$CODEX_HOME/sessions`). They come out as the events
 * a live turn produces (see events.ts), so a chat UI renders both the same way.
 *
 * The rollout format is Codex's own and not part of its SDK. Everything here is read
 * defensively: a record that isn't understood is skipped, never an error.
 */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const status = <T extends string>(v: unknown, known: readonly T[], fallback: T): T =>
  known.find((s) => s === v) ?? fallback;

/** The text of a message item's content parts. */
const contentText = (content: unknown) =>
  (Array.isArray(content) ? content : [])
    .map((part) => (isObject(part) ? str(part.text) : ""))
    .filter(Boolean)
    .join("\n");

/** One argument as a shell would need it written, the way Codex prints commands. */
function shellQuote(arg: string): string {
  if (/^[\w@%+=:,./-]+$/.test(arg)) return arg;
  if (!arg.includes("'")) return `'${arg}'`;
  return `"${arg.replace(/(["\\$`!])/g, "\\$1")}"`;
}

/** The rollout keeps a command as its arguments; a live event carries it as one line. */
function commandLine(command: unknown): string {
  return Array.isArray(command) ? command.map(str).map(shellQuote).join(" ") : str(command);
}

/** A rollout item as the SDK's `ThreadItem` (what a live stream carries), or null to skip it. */
export function threadItem(item: Json): ThreadItem | null {
  const id = str(item.id);
  switch (item.type) {
    case "AgentMessage":
      return { id, type: "agent_message", text: contentText(item.content) };
    case "Reasoning": {
      const text = (Array.isArray(item.summary_text) ? item.summary_text : []).map(str).join("\n");
      return text ? { id, type: "reasoning", text } : null;
    }
    case "CommandExecution":
      return {
        id,
        type: "command_execution",
        command: commandLine(item.command),
        aggregated_output: str(item.aggregated_output),
        ...(typeof item.exit_code === "number" ? { exit_code: item.exit_code } : {}),
        status: status(item.status, ["in_progress", "completed", "failed"], "completed"),
      };
    case "FileChange":
      return {
        id,
        type: "file_change",
        changes: Object.entries(isObject(item.changes) ? item.changes : {}).map(
          ([path, change]) => ({
            path,
            kind: status(
              isObject(change) ? change.type : "",
              ["add", "delete", "update"],
              "update",
            ),
          }),
        ),
        status: status(item.status, ["completed", "failed"], "completed"),
      };
    case "McpToolCall": {
      const result = isObject(item.result) ? item.result : undefined;
      const error = isObject(item.error) ? str(item.error.message) : str(item.error);
      return {
        id,
        type: "mcp_tool_call",
        server: str(item.server),
        tool: str(item.tool),
        arguments: item.arguments,
        ...(result
          ? {
              result: {
                content: Array.isArray(result.content) ? result.content : [],
                structured_content: result.structuredContent ?? result.structured_content,
              },
            }
          : {}),
        ...(error ? { error: { message: error } } : {}),
        status: status(item.status, ["in_progress", "completed", "failed"], "completed"),
      };
    }
    case "Extension":
    case "WebSearch":
      if (item.type === "Extension" && item.kind !== "web.search") return null;
      return { id, type: "web_search", query: str(item.query) };
    default:
      return null;
  }
}

/** How elseagent writes a chat message for Codex: `<@USER>: text` (see formatInput). */
const ADDRESSED = /^<@([^>\s]+)>: /;
/** How it lists a file attached to the message, on a line of its own (see describeFiles). */
const ATTACHED = /^\[attached file: (.+?)(?: \([^()]*\))?\]$/;

/** A user message as it was written: its text, and the files listed under it. */
function userMessage(raw: string): { text: string; user: string; files: EventFile[] } {
  const lines = raw.split("\n");
  const files: EventFile[] = [];
  for (let path = ATTACHED.exec(lines.at(-1) ?? "")?.[1]; path; ) {
    files.unshift({ name: basename(path), path });
    lines.pop();
    path = ATTACHED.exec(lines.at(-1) ?? "")?.[1];
  }
  const text = lines.join("\n");
  return { text: text.replace(ADDRESSED, ""), user: ADDRESSED.exec(text)?.[1] ?? "", files };
}

export interface HistoryOptions {
  /**
   * Leave out turns that started at or after this time (Unix epoch ms): the turn in progress,
   * which the live stream delivers.
   */
  before?: number;
}

/** The events of the turns recorded in a rollout file's text. */
export function rolloutEvents(jsonl: string, { before }: HistoryOptions = {}): SessionEvent[] {
  const events: SessionEvent[] = [];
  /** The turn being read: its id, and whether `turn_started` was emitted. */
  let turn: { id: string; started: boolean } | null = null;
  let at = 0;
  const emit = (body: SessionEventBody) => {
    events.push({ ...body, messageId: turn?.id ?? "", at });
  };
  const start = () => {
    if (!turn || turn.started) return;
    turn.started = true;
    emit({ type: "turn_started" });
  };
  const end = (how: Extract<SessionEventBody, { type: "turn_ended" }>["status"]) => {
    if (!turn) return;
    start();
    emit({ type: "turn_ended", status: how });
    turn = null;
  };

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a line still being written
    }
    if (!isObject(record) || record.type !== "event_msg" || !isObject(record.payload)) continue;
    const { payload } = record;
    at = Date.parse(str(record.timestamp)) || at;

    if (payload.type === "task_started") {
      end("interrupted"); // the previous turn never finished
      if (before !== undefined && at >= before) break;
      turn = { id: str(payload.turn_id), started: false };
    } else if (!turn) {
      // Not part of a turn we are reading.
    } else if (payload.type === "item_completed" && isObject(payload.item)) {
      if (payload.item.type === "UserMessage") {
        emit({ type: "user_message", ...userMessage(contentText(payload.item.content)) });
        start();
        continue;
      }
      const item = threadItem(payload.item);
      if (!item) continue;
      start();
      emit({ type: "codex", event: { type: "item.completed", item } });
    } else if (payload.type === "task_complete") {
      start();
      const final = str(payload.last_agent_message);
      const reply = final ? parseReply(final) : null;
      if (reply?.reply) {
        emit({
          type: "reply",
          text: reply.message,
          choices: reply.choices,
          files: reply.files.map((path) => ({ name: basename(path), path })),
        });
      }
      end("completed");
    } else if (payload.type === "turn_aborted") {
      end("interrupted");
    }
  }
  end("interrupted");
  return events;
}

/**
 * The finished turns of a conversation's Codex threads, oldest first. A thread whose history
 * Codex no longer has (deleted by cleanup) contributes nothing.
 */
export async function threadHistory(
  threadIds: readonly string[],
  options: HistoryOptions & { home?: string } = {},
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for (const threadId of threadIds) {
    const path = await rolloutPath(threadId, options.home ?? codexHome());
    if (!path) continue;
    try {
      events.push(...rolloutEvents(await Bun.file(path).text(), options));
    } catch {
      // deleted between the lookup and the read
    }
  }
  return events;
}
