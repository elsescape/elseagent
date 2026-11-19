import { basename } from "node:path";
import type { ThreadItem } from "@openai/codex-sdk";

export const THINKING = "is thinking…";
const MAX_LENGTH = 80;

const clip = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The status line for what Codex just started doing, or null to keep the current one. */
export function describeItem(item: ThreadItem): string | null {
  let status: string | null;
  switch (item.type) {
    case "reasoning":
      status = THINKING;
      break;
    case "command_execution":
      status = `is running \`${clip(item.command, 50)}\`…`;
      break;
    case "file_change": {
      const files = item.changes.map((c) => basename(c.path));
      status = `is editing ${files.slice(0, 2).join(", ")}${files.length > 2 ? ` and ${files.length - 2} more` : ""}…`;
      break;
    }
    case "mcp_tool_call":
      status = `is using ${item.server}.${item.tool}…`;
      break;
    case "web_search":
      status = `is searching the web for "${clip(item.query, 40)}"…`;
      break;
    case "agent_message":
      status = "is writing a reply…";
      break;
    default:
      status = null;
  }
  return status && clip(status, MAX_LENGTH);
}

export interface StatusOptions {
  /** Minimum time between two status updates sent to the chat. */
  minIntervalMs?: number;
  /** Re-send the current status this often: Slack drops it after 2 minutes. */
  refreshMs?: number;
}

/**
 * Keeps a thread's loading status in step with what Codex is doing, without flooding the chat:
 * updates are throttled (the latest one wins), and the status is refreshed before it expires.
 */
export class StatusTicker {
  private current = "";
  private sent = "";
  private lastSentAt = 0;
  private pending: ReturnType<typeof setTimeout> | undefined;
  private readonly refresh: ReturnType<typeof setInterval>;
  private stopped = false;
  private sending: Promise<void> | undefined;
  private readonly minIntervalMs: number;

  constructor(
    private readonly send: (status: string) => Promise<void>,
    { minIntervalMs = 3_000, refreshMs = 90_000 }: StatusOptions = {},
  ) {
    this.minIntervalMs = minIntervalMs;
    this.refresh = setInterval(() => void this.flush(true), refreshMs);
  }

  /** Show `status`, now or as soon as the throttle allows. */
  set(status: string): void {
    if (this.stopped || status === this.current) return;
    this.current = status;
    const wait = this.lastSentAt + this.minIntervalMs - Date.now();
    if (wait <= 0) {
      void this.flush();
    } else {
      this.pending ??= setTimeout(() => {
        this.pending = undefined;
        void this.flush();
      }, wait);
    }
  }

  /** Stop updating and clear the status. Calling it again does nothing. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.refresh);
    clearTimeout(this.pending);
    if (this.sent) {
      await this.sending;
      await this.send("").catch(() => {});
    }
  }

  private async flush(force = false): Promise<void> {
    if (this.stopped || !this.current || (!force && this.current === this.sent)) return;
    this.sent = this.current;
    this.lastSentAt = Date.now();
    const status = this.current;
    const send = () => this.send(status).catch(() => {});
    const sending = this.sending
      ? this.sending.then(() => (this.stopped ? undefined : send()))
      : send();
    this.sending = sending;
    await sending;
    if (this.sending === sending) this.sending = undefined;
  }
}
