import type { Caller } from "../../agent/admin.ts";
import type { IncomingMessage } from "../types.ts";

function tokenFrom(value: object): string | undefined {
  if ("action_token" in value && typeof value.action_token === "string" && value.action_token) {
    return value.action_token;
  }
}

/** Keeps Slack search credentials out of persisted messages and Codex's input. */
export class SlackActionTokens {
  private readonly recent = new Map<string, string>();

  remember(message: IncomingMessage, event: object, envelope: object): void {
    const assistantThread = "assistant_thread" in event ? event.assistant_thread : undefined;
    const nested =
      assistantThread && typeof assistantThread === "object"
        ? tokenFrom(assistantThread)
        : undefined;
    const token = tokenFrom(event) ?? nested ?? tokenFrom(envelope);
    if (!token || !message.ts) return;

    const key = JSON.stringify([message.channel, message.ts, message.user]);
    this.recent.set(key, token);
    if (this.recent.size > 1_000) {
      const oldest = this.recent.keys().next().value;
      if (oldest !== undefined) this.recent.delete(oldest);
    }
  }

  get(caller: Caller): string | undefined {
    if (!caller.messageTs) return;
    return this.recent.get(JSON.stringify([caller.channel, caller.messageTs, caller.user]));
  }
}
