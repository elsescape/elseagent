import type { IncomingMessage, Logger, MessageHandler, Reply } from "./types.ts";

/**
 * Hand a message to the agent. A handler that throws is logged and the user told, so one bad
 * message never takes the channel's event loop down.
 */
export async function dispatchMessage(
  platform: string,
  onMessage: MessageHandler,
  message: IncomingMessage,
  reply: Reply,
  logger: Pick<Logger, "warn">,
): Promise<void> {
  try {
    await onMessage(message, reply);
  } catch (err) {
    logger.warn(`${platform}: handler failed: ${(err as Error).stack ?? err}`);
    await reply.post("Sorry, something went wrong while handling that.").catch(() => {});
  }
}
