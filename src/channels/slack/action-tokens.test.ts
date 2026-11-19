import { expect, test } from "bun:test";
import { SlackActionTokens } from "./action-tokens.ts";

test("uses the Slack event or envelope token only for the originating message and user", () => {
  const tokens = new SlackActionTokens();
  const message = {
    channel: "C1234567890",
    ts: "1.0",
    threadTs: "1.0",
    user: "U1",
    text: "hello",
    isDirect: false,
  };
  const caller = {
    channel: message.channel,
    messageTs: message.ts,
    user: message.user,
    conversationKey: "C1234567890:1.0",
  };
  tokens.remember(message, {}, { action_token: "envelope" });
  expect(tokens.get(caller)).toBe("envelope");
  tokens.remember(message, { action_token: "event" }, { action_token: "envelope" });
  expect(tokens.get(caller)).toBe("event");
  expect(tokens.get({ ...caller, user: "U2" })).toBeUndefined();
  expect(tokens.get({ ...caller, messageTs: undefined })).toBeUndefined();
  expect(tokens.get({ ...caller, channel: "tg:1" })).toBeUndefined();
});
