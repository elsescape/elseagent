import { describe, expect, test } from "bun:test";
import type { ThreadItem } from "@openai/codex-sdk";
import { describeItem, StatusTicker, THINKING } from "./status.ts";

const item = (fields: Record<string, unknown>) => ({ id: "x", ...fields }) as ThreadItem;

describe("describeItem", () => {
  test("describes each kind of step", () => {
    expect(describeItem(item({ type: "reasoning", text: "" }))).toBe(THINKING);
    expect(describeItem(item({ type: "command_execution", command: "bun   test\n--watch" }))).toBe(
      "is running `bun test --watch`…",
    );
    expect(
      describeItem(
        item({
          type: "file_change",
          changes: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"].map((path) => ({
            path,
            kind: "update",
          })),
        }),
      ),
    ).toBe("is editing a.ts, b.ts and 2 more…");
    expect(describeItem(item({ type: "mcp_tool_call", server: "elseagent", tool: "status" }))).toBe(
      "is using elseagent.status…",
    );
    expect(describeItem(item({ type: "web_search", query: "bun sqlite wal" }))).toBe(
      'is searching the web for "bun sqlite wal"…',
    );
    expect(describeItem(item({ type: "agent_message", text: "" }))).toBe("is writing a reply…");
    expect(describeItem(item({ type: "todo_list", items: [] }))).toBeNull();
  });

  test("keeps statuses short", () => {
    const status = describeItem(item({ type: "command_execution", command: "x".repeat(500) }));
    expect(status?.length).toBeLessThanOrEqual(80);
  });
});

describe("StatusTicker", () => {
  function ticker(options: { minIntervalMs: number; refreshMs: number }) {
    const sent: string[] = [];
    const t = new StatusTicker(async (s) => void sent.push(s), options);
    return { t, sent };
  }

  test("sends right away, then throttles to the latest status", async () => {
    const { t, sent } = ticker({ minIntervalMs: 40, refreshMs: 60_000 });
    t.set("a");
    t.set("b");
    t.set("c");
    expect(sent).toEqual(["a"]);
    await Bun.sleep(60);
    expect(sent).toEqual(["a", "c"]); // "b" was superseded
    await t.stop();
    expect(sent).toEqual(["a", "c", ""]);
  });

  test("re-sends the status so Slack doesn't drop it", async () => {
    const { t, sent } = ticker({ minIntervalMs: 0, refreshMs: 20 });
    t.set("working");
    await Bun.sleep(50);
    await t.stop();
    expect(sent.filter((s) => s === "working").length).toBeGreaterThanOrEqual(2);
    expect(sent.at(-1)).toBe("");
  });

  test("does nothing after stop, and clears only if something was shown", async () => {
    const { t, sent } = ticker({ minIntervalMs: 0, refreshMs: 60_000 });
    await t.stop();
    t.set("late");
    expect(sent).toEqual([]);
  });

  test("clears only after the in-flight status update finishes", async () => {
    const update = Promise.withResolvers<void>();
    const sent: string[] = [];
    const t = new StatusTicker(
      async (status) => {
        if (status) await update.promise;
        sent.push(status);
      },
      { minIntervalMs: 0 },
    );
    t.set("working");
    t.set("next");
    const stopped = t.stop();
    update.resolve();
    await stopped;
    expect(sent).toEqual(["working", ""]);
  });
});
