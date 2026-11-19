import { expect, test } from "bun:test";
import { configuredChannelNames } from "./adapters.ts";
import { Channels } from "./registry.ts";
import type { Channel, Reply } from "./types.ts";

const fake = (platform: Channel["platform"], prefix: string): Channel => ({
  platform,
  label: platform,
  stateKey: `${platform}-test`,
  instructions: "",
  owns: (channel) => channel.startsWith(prefix),
  replyTo: () => ({ platform }) as unknown as Reply,
  threadContext: async () => ({ messages: [{ user: platform, text: "" }], omitted: 0 }),
  download: async () => {},
  ensureChannel: async (ref) => `${platform}:${ref}`,
  start: async () => {},
  stop: async () => {},
});

test("each call goes to the channel that owns the chat ID", async () => {
  const channels = new Channels([fake("telegram", "tg:"), fake("slack", "C")]);
  expect(channels.for("tg:1").platform).toBe("telegram");
  expect(channels.for("C1").platform).toBe("slack");
  expect(channels.replyTo({ channel: "C1", ts: "1" })).toEqual({ platform: "slack" } as never);
  const context = await channels.threadContext({ channel: "tg:1", ts: "1", threadTs: null }, null);
  expect(context.messages[0]?.user).toBe("telegram");
  expect(await channels.ensureChannel("tg:5")).toBe("telegram:tg:5");
});

test("a chat ID no channel owns is an error", () => {
  const channels = new Channels([fake("telegram", "tg:")]);
  expect(() => channels.for("C1")).toThrow("telegram");
  expect(() => new Channels([])).toThrow();
});

test("additional namespaced adapters coexist with existing chat IDs and state", () => {
  const slack = { ...fake("slack", "C"), owns: (chat: string) => !chat.includes(":") };
  const telegram = fake("telegram", "tg:");
  const socket = fake("socket", "local:");
  const channels = new Channels([slack, telegram, socket]);
  expect(channels.for("local:1")).toBe(socket);
  expect(channels.for("tg:1")).toBe(telegram);
  expect(channels.for("#ops")).toBe(slack);
  expect(channels.stateKey).toBe(slack.stateKey);
  expect(new Channels([telegram]).stateKey).toBe(telegram.stateKey);
  expect(() => channels.for("unknown:1")).toThrow("doesn't belong");
});

test("lists configured adapters in database identity order", () => {
  const slack = {
    botToken: "xoxb-test",
    appToken: "xapp-test",
    join: [],
    threadReplies: "auto",
  } as const;
  const telegram = { botToken: "test", allowedUsers: [] };
  expect(configuredChannelNames({ telegram })).toEqual(["telegram"]);
  expect(configuredChannelNames({ telegram, slack: { ...slack, join: [] } })).toEqual([
    "slack",
    "telegram",
  ]);
});
