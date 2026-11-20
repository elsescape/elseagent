import { truncate } from "../util/text.ts";

/** What Codex returns at the end of a turn (enforced with the SDK's `outputSchema`). */
export interface AgentReply {
  /** False: stay silent (honored for scheduled runs and messages not addressed to the agent). */
  reply: boolean;
  /** Markdown posted to the chat. */
  message: string;
  /** Options shown as buttons; empty when there is no decision to make. */
  choices: string[];
  /** Paths of files to send with the message. */
  files: string[];
}

/** JSON schema for AgentReply, in the strict form structured outputs require. */
export const REPLY_SCHEMA = {
  type: "object",
  properties: {
    reply: {
      type: "boolean",
      description:
        "Whether to post your message. Always true, except for scheduled checks with nothing to report " +
        "or a message not addressed to you that you decide not to answer.",
    },
    message: { type: "string", description: "Your reply, as Markdown (empty when not replying)." },
    choices: {
      type: "array",
      items: { type: "string" },
      description: "2 to 5 short options for the user to pick from, or empty.",
    },
    files: {
      type: "array",
      items: { type: "string" },
      description:
        "When delivering a generated file such as a chart, report or export, put its local path " +
        "here (relative to the working directory or absolute) so the channel can deliver it. " +
        "Keep the message body free of local paths and internal download URLs. Empty if there are no files.",
    },
  },
  required: ["reply", "message", "choices", "files"],
  additionalProperties: false,
} as const;

/** Slack limits: at most 25 buttons per block, 75 characters per button label. */
const MAX_CHOICES = 5;
const MAX_CHOICE_LENGTH = 75;

/** The reply object in Codex's final response, or null when it is anything else. */
function replyJson(text: string): Partial<AgentReply> | null {
  if (!text.trimStart().startsWith("{")) return null;
  try {
    const raw = JSON.parse(text) as Partial<AgentReply> | null;
    return typeof raw?.message === "string" ? raw : null;
  } catch {
    return null;
  }
}

/** Parse Codex's final response. Anything that isn't the expected JSON is posted as plain text. */
export function parseReply(finalResponse: string): AgentReply {
  const raw = replyJson(finalResponse);
  if (!raw) return { reply: true, message: finalResponse, choices: [], files: [] };
  const choices = (Array.isArray(raw.choices) ? raw.choices : [])
    .filter((c): c is string => typeof c === "string")
    .map((c) => c.trim())
    .filter((c, i, all) => c && all.indexOf(c) === i)
    .slice(0, MAX_CHOICES)
    .map((c) => truncate(c, MAX_CHOICE_LENGTH));
  const files = (Array.isArray(raw.files) ? raw.files : []).filter(
    (f): f is string => typeof f === "string" && f.trim() !== "",
  );
  return { reply: raw.reply !== false, message: raw.message ?? "", choices, files };
}

/** Scheduled results longer than this (characters or lines) are summarized, with details in the thread. */
const SCHEDULED_ROOT_CHARS = 1200;
const SCHEDULED_ROOT_LINES = 12;
const SCHEDULED_SUMMARY_CHARS = 400;

/**
 * A scheduled run's notification: a first line `⏰ **Task name**`, then the result, or for a long result its opening
 * paragraph (bounded) with the full text as `details`, to be posted in the thread.
 */
export function formatScheduledReply(
  title: string,
  text: string,
): { root: string; details?: string } {
  // Asterisks would end the bold early; angle brackets would turn into Slack mentions.
  const name = title.replace(/[<>*]/g, "").replace(/\s+/g, " ").trim();
  const heading = `⏰ **${name || "Scheduled task"}**`;
  if (text.length <= SCHEDULED_ROOT_CHARS && text.split("\n").length <= SCHEDULED_ROOT_LINES) {
    return { root: `${heading}\n\n${text}` };
  }
  return { root: `${heading}\n\n${summarize(text)}\n\nDetails in thread.`, details: text };
}

/** The opening paragraph, cut at a word boundary, never inside a code block or a character. */
function summarize(text: string): string {
  let opening = text.split(/\n\s*\n/, 1)[0]?.trim() || text.trim();
  const fence = opening.indexOf("```");
  if (fence >= 0) opening = opening.slice(0, fence).trim();
  const chars = Array.from(opening);
  if (chars.length <= SCHEDULED_SUMMARY_CHARS) {
    if (!opening) return "(see the thread)";
    return fence >= 0 ? `${opening}…` : opening;
  }
  const cut = chars.slice(0, SCHEDULED_SUMMARY_CHARS - 1).join("");
  const space = cut.search(/\s\S*$/);
  return `${(space > SCHEDULED_SUMMARY_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
