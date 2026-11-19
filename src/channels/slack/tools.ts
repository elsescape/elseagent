import type { webApi } from "@slack/bolt";
import { z } from "zod";
import { AdminError, type Caller } from "../../agent/admin.ts";
import { callTool, type ToolGroup } from "../../mcp/tools.ts";
import { truncate } from "../../util/text.ts";
import { isSlackChannelId, resolveChannelId } from "./channels.ts";

export function createSlackTools(
  client: SlackToolsClient,
  actionTokenFor: (caller: Caller) => string | undefined,
): ToolGroup {
  return (server, admin, caller) => {
    server.registerTool(
      "slack_thread_follow",
      {
        description:
          "Stop following a Slack thread (follow=false: only answer when mentioned there) or follow " +
          "it again (follow=true: read every reply and decide whether to answer). Use it when someone " +
          "asks you to stay out of a thread or to come back. Defaults to the current thread.",
        inputSchema: {
          follow: z.boolean(),
          conversation: z
            .string()
            .optional()
            .describe("A conversation from general_list_sessions; defaults to the current one"),
        },
        annotations: { openWorldHint: false },
      },
      ({ follow, conversation }) =>
        callTool(() => admin.threadFollow(follow, caller, conversation)),
    );

    server.registerTool(
      "slack_read_channel",
      {
        description:
          "Read recent top-level Slack messages. Public channels must already include the bot. " +
          "Private channels and DMs are only readable from the conversation being answered. Use slack_read_thread for replies.",
        inputSchema: {
          channel: channelRef,
          hours: z.number().positive().max(8_760).optional().describe("Look back this many hours"),
          ...pageInput,
        },
        annotations: readOnly,
      },
      ({ channel, hours, limit, cursor }) =>
        callTool(async () => {
          const id = await readableChannel(client, caller, channel);
          const result = await client.conversations.history({
            channel: id,
            limit: limit ?? 20,
            cursor,
            oldest: hours === undefined ? undefined : String(Date.now() / 1_000 - hours * 3_600),
          });
          return {
            channel: id,
            messages: (result.messages ?? [])
              .slice(0, limit ?? 20)
              .toReversed()
              .map(messageSummary),
            nextCursor: result.response_metadata?.next_cursor || null,
          };
        }),
    );
    server.registerTool(
      "slack_read_thread",
      {
        description:
          "Read the root and replies of a Slack thread using the root timestamp. " +
          "For private channels and DMs, the thread must be in the conversation being answered.",
        inputSchema: {
          channel: channelRef,
          thread_ts: z
            .string()
            .regex(/^\d+\.\d+$/)
            .describe("Root message timestamp"),
          ...pageInput,
        },
        annotations: readOnly,
      },
      ({ channel, thread_ts, limit, cursor }) =>
        callTool(async () => {
          const id = await readableChannel(client, caller, channel);
          const result = await client.conversations.replies({
            channel: id,
            ts: thread_ts,
            limit: limit ?? 20,
            cursor,
          });
          return {
            channel: id,
            threadTs: thread_ts,
            messages: (result.messages ?? []).slice(0, limit ?? 20).map(messageSummary),
            nextCursor: result.response_metadata?.next_cursor || null,
          };
        }),
    );
    server.registerTool(
      "slack_search",
      {
        description:
          "Search public Slack messages. Requires an active Slack message with a search action token, such as a DM or @mention. Results include message permalinks.",
        inputSchema: {
          query: z.string().trim().min(1).max(1_000),
          limit: z.number().int().min(1).max(20).optional().describe("Default: 10"),
          sort: z.enum(["score", "timestamp"]).optional().describe("Relevance or newest first"),
          cursor: pageInput.cursor,
        },
        annotations: readOnly,
      },
      ({ query, limit, sort, cursor }) =>
        callTool(async () => {
          const token = actionTokenFor(caller);
          if (!token)
            throw new AdminError(
              "Slack search needs a current Slack DM or @mention with an action token.",
            );
          let result: SlackSearchResponse;
          try {
            result = await client.apiCall("assistant.search.context", {
              query,
              action_token: token,
              channel_types: "public_channel",
              content_types: "messages",
              limit: limit ?? 10,
              sort: sort ?? "score",
              cursor,
            });
          } catch (err) {
            const error = (err as { data?: { error?: string } }).data?.error;
            if (error === "missing_scope") {
              throw new AdminError(
                "Slack search requires search:read.public. Update the manifest and reinstall the Slack app.",
              );
            }
            if (error === "invalid_action_token") {
              throw new AdminError(
                "The Slack search action token is no longer valid. Send a fresh Slack DM or @mention.",
              );
            }
            throw err;
          }
          return {
            messages: (result.results?.messages ?? []).slice(0, limit ?? 10).map((message) => ({
              channel: message.channel_id,
              channelName: message.channel_name,
              ts: message.message_ts,
              threadTs: message.thread_ts,
              author: message.author_user_id,
              text: truncate(message.content ?? "", 2_000),
              permalink: message.permalink,
            })),
            nextCursor: result.response_metadata?.next_cursor || null,
          };
        }),
    );
  };
}

type SlackToolsClient = Pick<webApi.WebClient, "apiCall"> & {
  conversations: Pick<webApi.WebClient["conversations"], "list" | "info" | "history" | "replies">;
};

const channelRef = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .optional()
  .describe(
    "Slack channel ID or public #channel-name. Defaults to the current Slack conversation.",
  );
const pageInput = {
  limit: z.number().int().min(1).max(50).optional().describe("Default: 20"),
  cursor: z
    .string()
    .min(1)
    .max(1_000)
    .optional()
    .describe("Opaque nextCursor from a previous result"),
};
const readOnly = { readOnlyHint: true, openWorldHint: true };
async function readableChannel(client: SlackToolsClient, caller: Caller, ref?: string) {
  const target = ref ?? caller.channel;
  if (!isSlackChannelId(target) && !/^#?[a-z0-9_-]+$/i.test(target)) {
    throw new AdminError("Choose a Slack channel ID or a public #channel-name.");
  }
  if (/^[UW][A-Z0-9]+$/.test(target))
    throw new AdminError("Use a Slack channel ID, rather than a user ID.");
  const channel = await resolveChannelId(client, target);
  if (channel === caller.channel && caller.messageTs) return channel;
  if (channel.startsWith("D")) {
    throw new AdminError(
      "Private Slack conversations can only be read while answering a message there.",
    );
  }
  const { channel: info } = await client.conversations.info({ channel });
  if (info?.is_channel !== true || info.is_private !== false || info.is_im || info.is_mpim) {
    throw new AdminError(
      "Private Slack conversations can only be read while answering a message there.",
    );
  }
  if (info.is_member === false) {
    throw new AdminError("Invite the Slack bot to that public channel before reading its history.");
  }
  return channel;
}

function messageSummary(message: {
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  reply_count?: number;
}) {
  return {
    ts: message.ts,
    threadTs: message.thread_ts,
    user: message.user,
    botId: message.bot_id,
    text: truncate(message.text ?? "", 2_000),
    replyCount: message.reply_count,
  };
}

interface SlackSearchResponse {
  results?: {
    messages?: {
      channel_id?: string;
      channel_name?: string;
      message_ts?: string;
      thread_ts?: string;
      author_user_id?: string;
      content?: string;
      permalink?: string;
    }[];
  };
  response_metadata?: { next_cursor?: string };
}
