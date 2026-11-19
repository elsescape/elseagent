import { describe, expect, test } from "bun:test";
import { EventHub, type LiveEvent } from "./events.ts";

const types = (events: LiveEvent[]) => events.map((e) => `${e.messageId}:${e.type}`);

function turn(hub: EventHub, session: string, id: string) {
  hub.publish(session, id, { type: "user_message", text: id, user: "web" });
  hub.publish(session, id, { type: "turn_started" });
}
const end = (hub: EventHub, session: string, id: string) =>
  hub.publish(session, id, { type: "turn_ended", status: "completed" });

describe("EventHub", () => {
  test("live events are those of turns that have not ended", () => {
    const hub = new EventHub();
    expect(hub.live("s")).toEqual([]);
    turn(hub, "s", "m1");
    hub.publish("s", "m2", { type: "user_message", text: "queued", user: "web" });
    expect(types(hub.live("s"))).toEqual(["m1:user_message", "m1:turn_started", "m2:user_message"]);
    expect(hub.has("s", "m1")).toBe(true);
    end(hub, "s", "m1");
    expect(hub.has("s", "m1")).toBe(false);
    expect(types(hub.live("s"))).toEqual(["m2:user_message"]);
    expect(hub.live("other")).toEqual([]);
  });

  test("a subscriber gets the turns in progress, then what follows", () => {
    const hub = new EventHub();
    turn(hub, "s", "m1");
    end(hub, "s", "m1");
    turn(hub, "s", "m2");
    const seen: LiveEvent[] = [];
    const unsubscribe = hub.subscribe("s", undefined, (e) => seen.push(e));
    hub.publish("s", "m2", { type: "status", text: "is thinking…" });
    hub.publish("other", "x", { type: "turn_started" });
    expect(types(seen)).toEqual(["m2:user_message", "m2:turn_started", "m2:status"]);
    unsubscribe();
    end(hub, "s", "m2");
    expect(seen).toHaveLength(3);
  });

  test("a cursor resumes after it, including a turn that ended meanwhile", () => {
    const hub = new EventHub();
    turn(hub, "s", "m1");
    const cursor = hub.cursor;
    hub.publish("s", "m1", { type: "reply", text: "done", choices: [], files: [] });
    end(hub, "s", "m1");
    const seen: LiveEvent[] = [];
    hub.subscribe("s", cursor, (e) => seen.push(e));
    expect(types(seen)).toEqual(["m1:reply", "m1:turn_ended"]);
    expect(seen.map((e) => e.seq)).toEqual([3, 4]);
  });

  test("a cursor from another process or a malformed one is ignored", () => {
    const hub = new EventHub();
    turn(hub, "s", "m1");
    end(hub, "s", "m1");
    for (const cursor of ["deadbeef:1", "nonsense", `${hub.epoch}:x`, ""]) {
      const seen: LiveEvent[] = [];
      hub.subscribe("s", cursor, (e) => seen.push(e));
      expect(seen).toEqual([]);
    }
  });

  test("a new message after a finished turn starts the buffer over", () => {
    const hub = new EventHub();
    turn(hub, "s", "m1");
    end(hub, "s", "m1");
    const cursor = `${hub.epoch}:0`;
    turn(hub, "s", "m2");
    const seen: LiveEvent[] = [];
    hub.subscribe("s", cursor, (e) => seen.push(e));
    expect(types(seen)).toEqual(["m2:user_message", "m2:turn_started"]);
  });

  test("keeps at most maxEvents and forgets idle sessions", () => {
    let now = 0;
    const hub = new EventHub({ maxEvents: 3, retainMs: 1000, now: () => now });
    turn(hub, "s", "m1");
    for (const text of ["a", "b", "c"]) hub.publish("s", "m1", { type: "status", text });
    expect(hub.live("s").map((e) => e.type)).toEqual(["status", "status", "status"]);
    end(hub, "s", "m1");
    const cursor = `${hub.epoch}:0`;
    now = 2000;
    turn(hub, "other", "x"); // any activity sweeps
    const seen: LiveEvent[] = [];
    hub.subscribe("s", cursor, (e) => seen.push(e));
    expect(seen).toEqual([]);
  });

  test("a dropped session's subscribers hear nothing more", () => {
    const hub = new EventHub();
    const seen: LiveEvent[] = [];
    hub.subscribe("s", undefined, (e) => seen.push(e));
    hub.drop("s");
    turn(hub, "s", "m1");
    expect(seen).toEqual([]);
  });
});
