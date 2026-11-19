import { describe, expect, test } from "bun:test";
import {
  conversationKey,
  deduplicateMessages,
  fromDirectMessage,
  fromMention,
  fromThreadMessage,
  slackFiles,
  slashCommandMessage,
  stopButtonMessage,
  stripMention,
} from "./message.ts";

const BOT = "UBOT";

test("Slack retries and duplicate subscriptions dispatch once per channel and timestamp", async () => {
  const received: string[] = [];
  const pending = Promise.withResolvers<void>();
  const dispatch = deduplicateMessages(async ({ channel }) => {
    received.push(channel);
    await pending.promise;
  });
  const message = {
    channel: "C1",
    ts: "1.0",
    threadTs: "1.0",
    user: "U1",
    text: "hello",
    isDirect: false,
  };
  const first = dispatch(message);
  const duplicate = dispatch({ ...message });
  const otherChannel = dispatch({ ...message, channel: "C2" });
  pending.resolve();
  await Promise.all([first, duplicate, otherChannel]);
  await dispatch(message);
  expect(received).toEqual(["C1", "C2"]);
});

type MentionEvent = Parameters<typeof fromMention>[0];
type MessageEvent = Parameters<typeof fromDirectMessage>[0];

const mention = (fields: Partial<MentionEvent>): MentionEvent =>
  ({
    type: "app_mention",
    channel: "C1",
    ts: "100.1",
    event_ts: "100.1",
    user: "U1",
    text: `<@${BOT}> hello`,
    ...fields,
  }) as MentionEvent;

const dm = (fields: Record<string, unknown>): MessageEvent =>
  ({
    type: "message",
    subtype: undefined,
    channel: "D1",
    channel_type: "im",
    ts: "200.1",
    event_ts: "200.1",
    user: "U1",
    text: "hi",
    ...fields,
  }) as MessageEvent;

describe("stripMention", () => {
  test("removes the bot mention and collapses whitespace", () => {
    expect(stripMention(`<@${BOT}>  fix   the build <@${BOT}>`, BOT)).toBe("fix the build");
  });

  test("keeps mentions of other users", () => {
    expect(stripMention(`<@${BOT}> ask <@U2>`, BOT)).toBe("ask <@U2>");
  });
});

describe("fromMention", () => {
  test("starts a thread on a top-level mention", () => {
    expect(fromMention(mention({}), BOT)).toEqual({
      channel: "C1",
      ts: "100.1",
      threadTs: "100.1",
      user: "U1",
      text: "hello",
      isDirect: false,
    });
  });

  test("replies in the existing thread", () => {
    expect(fromMention(mention({ thread_ts: "99.0" }), BOT)?.threadTs).toBe("99.0");
  });

  test("ignores bots and itself", () => {
    expect(fromMention(mention({ bot_id: "B1" }), BOT)).toBeNull();
    expect(fromMention(mention({ user: BOT }), BOT)).toBeNull();
    expect(fromMention(mention({ user: undefined }), BOT)).toBeNull();
  });
});

describe("fromDirectMessage", () => {
  test("handles a top-level DM without a thread", () => {
    expect(fromDirectMessage(dm({}), BOT)).toEqual({
      channel: "D1",
      ts: "200.1",
      threadTs: undefined,
      user: "U1",
      text: "hi",
      isDirect: true,
    });
  });

  test("keeps the thread for DM thread replies", () => {
    expect(fromDirectMessage(dm({ thread_ts: "150.0" }), BOT)?.threadTs).toBe("150.0");
  });

  test("ignores channel messages (handled via app_mention)", () => {
    expect(fromDirectMessage(dm({ channel_type: "channel" }), BOT)).toBeNull();
  });

  test("ignores edits, bots and its own messages", () => {
    expect(fromDirectMessage(dm({ subtype: "message_changed" }), BOT)).toBeNull();
    expect(fromDirectMessage(dm({ bot_id: "B1" }), BOT)).toBeNull();
    expect(fromDirectMessage(dm({ user: BOT }), BOT)).toBeNull();
  });
});

test("a DM slash command becomes a message with no ts, at the DM's top level", () => {
  const m = slashCommandMessage("D1", "U1", "/new");
  expect(m).toEqual({
    channel: "D1",
    ts: "",
    threadTs: undefined,
    user: "U1",
    text: "/new",
    isDirect: true,
  });
  expect(conversationKey(m)).toBe("D1");
});

describe("conversationKey", () => {
  test("a thread is its own conversation; a DM's top level is one conversation", () => {
    expect(conversationKey({ channel: "C1", threadTs: "1.0" })).toBe("C1:1.0");
    expect(conversationKey({ channel: "D1", threadTs: undefined })).toBe("D1");
  });
});

describe("fromThreadMessage", () => {
  const reply = (fields: Record<string, unknown>) =>
    dm({ channel: "C1", channel_type: "channel", ts: "300.1", thread_ts: "100.1", ...fields });

  test("a thread reply without a mention of the agent", () => {
    expect(fromThreadMessage(reply({ text: "looks good" }), BOT)).toEqual({
      channel: "C1",
      ts: "300.1",
      threadTs: "100.1",
      user: "U1",
      text: "looks good",
      isDirect: false,
      unaddressed: { mentionsOthers: false },
    });
    expect(fromThreadMessage(reply({ text: "<@U2> can you?" }), BOT)?.unaddressed).toEqual({
      mentionsOthers: true,
    });
    expect(fromThreadMessage(reply({ channel_type: "group" }), BOT)).not.toBeNull();
  });

  test("ignores mentions of the agent (app_mention handles them), roots, DMs, bots, edits", () => {
    expect(fromThreadMessage(reply({ text: `<@${BOT}> hi` }), BOT)).toBeNull();
    expect(fromThreadMessage(reply({ thread_ts: undefined }), BOT)).toBeNull();
    expect(fromThreadMessage(reply({ thread_ts: "300.1" }), BOT)).toBeNull(); // the root
    expect(fromThreadMessage(reply({ channel_type: "im" }), BOT)).toBeNull();
    expect(fromThreadMessage(reply({ bot_id: "B1" }), BOT)).toBeNull();
    expect(fromThreadMessage(reply({ user: BOT }), BOT)).toBeNull();
    expect(fromThreadMessage(reply({ subtype: "message_changed" }), BOT)).toBeNull();
  });
});

describe("files", () => {
  const file = {
    name: "log.txt",
    mimetype: "text/plain",
    size: 12,
    url_private_download: "https://files.slack.com/files-pri/T1-F1/download/log.txt",
  };
  const ref = file.url_private_download;
  const attachment = { name: "log.txt", mimetype: "text/plain", size: 12, ref };

  test("files with a download URL; deleted and external ones are left out", () => {
    expect(
      slackFiles([
        file,
        { ...file, mode: "tombstone" },
        { name: "ext", url_private_download: undefined },
        { title: "untitled", url_private: "https://files.slack.com/x" },
      ]),
    ).toEqual([attachment, { name: "untitled", ref: "https://files.slack.com/x" }]);
  });

  test("mentions, DMs and thread messages carry their files", () => {
    expect(fromMention(mention({ files: [file] } as never), BOT)?.files).toEqual([attachment]);
    expect(fromMention(mention({}), BOT)).not.toHaveProperty("files");
    const shared = dm({ subtype: "file_share", text: "", files: [file] });
    expect(fromDirectMessage(shared, BOT)).toMatchObject({ text: "", files: [attachment] });
    const inThread = dm({
      subtype: "file_share",
      channel: "C1",
      channel_type: "channel",
      thread_ts: "100.0",
      files: [file],
    });
    expect(fromThreadMessage(inThread, BOT)?.files).toEqual([attachment]);
  });
});

test("the stop button becomes !stop from the user who clicked, in that thread", () => {
  expect(stopButtonMessage({ channel: "C1", thread_ts: "1.0", user: "U2" })).toEqual({
    channel: "C1",
    ts: "",
    threadTs: "1.0",
    user: "U2",
    text: "!stop",
    isDirect: false,
  });
  expect(stopButtonMessage({ channel: "D1", thread_ts: "1.0", user: "U2" }).isDirect).toBe(true);
});
