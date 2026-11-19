import { describe, expect, test } from "bun:test";
import type { IncomingMessage, Reply } from "../channels/types.ts";
import { type NewQueuedMessage, openStateDb, SessionStore } from "../state/index.ts";
import { MUTED_REPLY, UNMUTED_REPLY } from "./follow.ts";
import { createMessageHandler, NOTHING_TO_STOP } from "./inbox.ts";

function setup() {
  const sessions = new SessionStore(openStateDb(":memory:"));
  const submitted: NewQueuedMessage[] = [];
  const posts: string[] = [];
  const reactions: string[] = [];
  const cancelled: [string, string][] = [];
  let running = true;
  const reply: Reply = {
    post: async (text) => {
      posts.push(text);
      return undefined;
    },
    react: async (name) => void reactions.push(name),
    unreact: async () => {},
    setStatus: async () => {},
  };
  const handle = createMessageHandler({
    scheduler: {
      submit: (m) => {
        submitted.push(m);
        return { status: "queued", position: 1 };
      },
      cancel: (key, by) => {
        cancelled.push([key, by]);
        return running;
      },
    },
    sessions,
  });
  const send = (m: Partial<IncomingMessage>) =>
    handle(
      {
        channel: "C1",
        ts: "2.0",
        threadTs: "1.0",
        user: "U1",
        text: "hello",
        isDirect: false,
        ...m,
      },
      reply,
    );
  const setRunning = (value: boolean) => {
    running = value;
  };
  return { sessions, submitted, posts, reactions, send, cancelled, setRunning };
}

const thread = (mentionsOthers = false) => ({ unaddressed: { mentionsOthers } });

describe("message handler", () => {
  test("a mention is direct and makes the agent follow the thread", async () => {
    const { send, submitted, sessions, reactions } = setup();
    await send({ text: "fix the build" });
    expect(submitted.map((m) => m.mode)).toEqual(["direct"]);
    expect(reactions).toEqual(["queued"]);
    expect(sessions.followState("C1:1.0")).toMatchObject({ muted: false, unanswered: 0 });
  });

  test("an unmentioned reply in a thread the agent isn't in: context only", async () => {
    const { send, submitted } = setup();
    await send({ ...thread() });
    expect(submitted).toEqual([]);
  });

  test("in a followed thread: passive and quiet; mentions of others are skipped", async () => {
    const { send, submitted, sessions, reactions } = setup();
    sessions.addressed("C1:1.0");
    await send({ ts: "3.0", user: "U2", text: "what do you think?", ...thread() });
    await send({ ts: "4.0", user: "U2", text: "<@U3> can you check?", ...thread(true) });
    expect(submitted.map((m) => [m.ts, m.mode])).toEqual([["3.0", "passive"]]);
    expect(reactions).toEqual([]); // no ⏳ on a message nobody sent to the agent
    expect(sessions.followState("C1:1.0")?.unanswered).toBe(2);
  });

  test("the person the agent just answered: a follow-up (visible, may go unanswered)", async () => {
    const { send, submitted, sessions } = setup();
    sessions.addressed("C1:1.0");
    sessions.replied("C1:1.0", "U1");
    await send({ ts: "3.0", user: "U1", text: "yes, go ahead", ...thread() });
    expect(submitted.map((m) => m.mode)).toEqual(["followup"]);
  });

  test("!mute and !unmute, mentioned or not", async () => {
    const { send, submitted, sessions, posts } = setup();
    await send({ text: "!mute" }); // "@agent !mute"
    expect(sessions.followState("C1:1.0")?.muted).toBe(true);
    await send({ ts: "3.0", text: "anyone?", ...thread() });
    await send({ ts: "4.0", text: "!unmute", ...thread() });
    expect(sessions.followState("C1:1.0")?.muted).toBe(false);
    expect(posts).toEqual([MUTED_REPLY, UNMUTED_REPLY]);
    expect(submitted).toEqual([]);
  });

  test("DMs are unaffected: always direct, no follow commands", async () => {
    const { send, submitted } = setup();
    await send({ channel: "D1", threadTs: undefined, isDirect: true, text: "!mute" });
    expect(submitted.map((m) => [m.text, m.mode])).toEqual([["!mute", "direct"]]);
  });

  test("!stop stops the conversation's running turn at once, anywhere, mentioned or not", async () => {
    const { send, submitted, cancelled, posts, setRunning } = setup();
    await send({ text: " !STOP " });
    await send({ text: "!stop", user: "U2", ...thread() }); // followed or not
    await send({ channel: "D1", threadTs: undefined, isDirect: true, text: "!stop" });
    expect(cancelled).toEqual([
      ["C1:1.0", "U1"],
      ["C1:1.0", "U2"],
      ["D1", "U1"],
    ]);
    expect(submitted).toEqual([]);
    expect(posts).toEqual([]); // the stopped turn says who stopped it
    setRunning(false);
    await send({ text: "!stop" });
    expect(posts).toEqual([NOTHING_TO_STOP]);
    await send({ text: "please !stop" });
    expect(submitted.map((m) => m.text)).toEqual(["please !stop"]);
  });
});
