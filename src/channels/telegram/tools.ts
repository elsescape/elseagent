import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";
import { AdminError, type Caller } from "../../agent/admin.ts";
import { MAX_REPLY_FILES, resolveReplyFiles } from "../../agent/files.ts";
import { callTool, type ToolGroup } from "../../mcp/tools.ts";
import type { OutgoingFile, Reply, ReplyTarget } from "../types.ts";
import { chatIdOf, MAX_UPLOAD_BYTES } from "./message.ts";
import type { TelegramClient } from "./reply.ts";

const topicInput = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Existing topic ID in your private bot chat. Omit to use the current topic.");

function currentTopic(caller: Caller): number | undefined {
  if (!caller.conversationKey.startsWith(`${caller.channel}:`)) return;
  const id = Number(caller.conversationKey.slice(caller.channel.length + 1));
  if (Number.isSafeInteger(id) && id > 0) return id;
}

async function prepareFiles(paths: string[], workspace?: string): Promise<OutgoingFile[]> {
  if (paths.length === 0) return [];
  if (!workspace) throw new AdminError("This turn has no workspace for attachments.");
  const root = await realpath(workspace);
  const { files, problems } = await resolveReplyFiles(paths, root);
  if (problems.length) throw new AdminError(problems.join("\n"));
  return Promise.all(
    files.map(async (file) => {
      const path = await realpath(file.path);
      const fromRoot = relative(root, path);
      if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
        throw new AdminError("Telegram attachments must be inside the workspace.");
      }
      if (Bun.file(path).size > MAX_UPLOAD_BYTES) {
        throw new AdminError(`${file.name} exceeds Telegram's 50 MB file limit.`);
      }
      return { ...file, path };
    }),
  );
}

export function createTelegramTools({
  api,
  allowed,
  topicsEnabled,
  replyTo,
}: {
  api: Pick<TelegramClient, "call">;
  allowed: ReadonlySet<string>;
  topicsEnabled: boolean;
  replyTo(target: ReplyTarget, options: { strictFiles: boolean }): Reply;
}): ToolGroup {
  return (server, _admin, caller) => {
    const chatId = chatIdOf(caller.channel);
    // A scheduled run can target Telegram without having been requested by this Telegram user.
    if (
      !caller.messageTs ||
      chatId === null ||
      String(chatId) !== caller.user ||
      !allowed.has(caller.user)
    )
      return;
    const topicOf = (requested?: number) => {
      const id = requested ?? currentTopic(caller);
      if (id !== undefined && !topicsEnabled) {
        throw new AdminError("Enable threaded mode for this bot in BotFather to use topics.");
      }
      return id;
    };

    server.registerTool(
      "telegram_send",
      {
        description:
          "Send a message or workspace files to an existing topic in your Telegram private chat when you explicitly want a separate delivery. Ordinary replies are sent automatically.",
        inputSchema: {
          topic_id: topicInput,
          text: z.string().trim().min(1).max(32_000).optional().describe("Markdown message"),
          files: z
            .array(z.string().trim().min(1))
            .max(MAX_REPLY_FILES)
            .optional()
            .describe("Workspace file paths"),
        },
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      ({ topic_id, text, files = [] }) =>
        callTool(async () => {
          if (!text && files.length === 0)
            throw new AdminError("Provide text or at least one file.");
          const topicId = topicOf(topic_id);
          const attachments = await prepareFiles(files, caller.workspace);
          const reply = replyTo(
            {
              channel: caller.channel,
              ts: "",
              threadTs: topicId === undefined ? undefined : String(topicId),
            },
            { strictFiles: true },
          );
          try {
            const messageId = await reply.post(text ?? "", [], attachments);
            return {
              sent: true,
              topicId,
              messageId,
              attachedFiles: attachments.map((file) => file.name),
            };
          } catch (err) {
            throw new AdminError(
              `Telegram delivery failed and may be partial. Check the destination before retrying. ${(err as Error).message}`,
            );
          }
        }),
    );

    server.registerTool(
      "telegram_rename_topic",
      {
        description:
          "Rename an existing topic in your Telegram private chat when explicitly requested.",
        inputSchema: {
          topic_id: topicInput,
          name: z.string().trim().min(1).max(128).describe("New topic title"),
        },
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      ({ topic_id, name }) =>
        callTool(async () => {
          const topicId = topicOf(topic_id);
          if (topicId === undefined)
            throw new AdminError("Specify a topic ID or make the request inside a Telegram topic.");
          await api.call("editForumTopic", { chat_id: chatId, message_thread_id: topicId, name });
          return { topicId, name };
        }),
    );
  };
}
