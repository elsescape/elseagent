import type { FollowState } from "../state/index.ts";
import { DAY_MS } from "../util/time.ts";

/** A thread stops being followed after this many messages without a reply from the agent… */
export const FOLLOW_MAX_UNANSWERED = 100;
/** …or this long since it was last mentioned or replied. */
export const FOLLOW_IDLE_MS = 10 * DAY_MS;

/** `!mute` / `!unmute` in a thread: quick, without a Codex turn. (Plain words work too.) */
export function followCommand(text: string): "mute" | "unmute" | null {
  const command = text.trim().toLowerCase();
  if (command === "!mute") return "mute";
  if (command === "!unmute") return "unmute";
  return null;
}

export const MUTED_REPLY = "OK, I'll stay out of this thread unless you mention me.";
export const UNMUTED_REPLY = "OK, I'm following this thread again.";

/** Whether the agent reads a thread's messages that don't mention it. */
export function isFollowing(state: FollowState | null, now: number): boolean {
  if (!state || state.muted || state.unanswered >= FOLLOW_MAX_UNANSWERED) return false;
  return now - (state.lastAddressedAt ?? state.lastActiveAt) < FOLLOW_IDLE_MS;
}

export type ThreadRoute =
  /** Leave it: it is context for the agent's next turn. */
  | { kind: "ignore" }
  /** Likely a reply to the agent's last answer: handled like a mention, may go unanswered. */
  | { kind: "followup" }
  /** Let Codex decide whether to reply. */
  | { kind: "passive" };

/**
 * Where a thread message that doesn't mention the agent goes (mentions are always answered).
 * Called before the message is counted as unanswered.
 */
export function routeThreadMessage(
  state: FollowState | null,
  message: { user: string; mentionsOthers: boolean },
  now: number,
): ThreadRoute {
  if (!isFollowing(state, now) || !state) return { kind: "ignore" };
  // Addressed to someone else.
  if (message.mentionsOthers) return { kind: "ignore" };
  // The agent spoke last, to this person: they are answering it.
  if (state.unanswered === 0 && state.repliedTo === message.user) return { kind: "followup" };
  return { kind: "passive" };
}
