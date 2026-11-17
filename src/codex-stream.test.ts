import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ItemCompletedEvent } from "@openai/codex-sdk";
import { createCodex } from "./codex.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Real SDK/subprocess boundary, without invoking a model or external tools. */
async function fakeCli(output: string, splitAt?: number, exitCode = 0) {
  const dir = await mkdtemp(join(tmpdir(), "elseagent-stream-"));
  dirs.push(dir);
  const path = join(dir, "codex");
  await Bun.write(
    path,
    `#!/usr/bin/env bun
for await (const _ of process.stdin) {}
const bytes = Buffer.from(${JSON.stringify(output)});
const split = ${splitAt ?? 0};
if (split) {
  process.stdout.write(bytes.subarray(0, split));
  await Bun.sleep(10);
}
process.stdout.write(bytes.subarray(split));
process.exitCode = ${exitCode};
`,
  );
  await chmod(path, 0o755);
  return createCodex({ codexPath: path }).startThread();
}

const completed = (text: string): ItemCompletedEvent => ({
  type: "item.completed",
  item: {
    id: "tool",
    type: "command_execution",
    command: "read webpage",
    aggregated_output: text,
    exit_code: 0,
    status: "completed",
  },
});

describe("Codex event framing", () => {
  test("keeps webpage Unicode line separators inside the JSON event", async () => {
    const event = completed("The Promenade Mall\u2028#B1-41\u2029Singapore 猫 🐈");
    const output = `${[
      { type: "thread.started", thread_id: "saved-thread" },
      event,
      {
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n")}\n`;
    // Split in the middle of U+2028's UTF-8 bytes as well as between stream chunks.
    const splitAt = Buffer.from(output).indexOf(Buffer.from("\u2028")) + 1;
    const thread = await fakeCli(output, splitAt);
    const { events } = await thread.runStreamed("check this place");
    const received = [];
    for await (const item of events) received.push(item);
    expect(received[1]).toEqual(event);
    expect(received).toHaveLength(3);
    expect(thread.id).toBe("saved-thread");
  });

  test("accepts CRLF boundaries and a final event without a trailing newline", async () => {
    const first = completed("first\nsecond\rthird");
    const last = completed("last");
    const thread = await fakeCli(`${JSON.stringify(first)}\r\n${JSON.stringify(last)}`);
    const { events } = await thread.runStreamed("check");
    const received = [];
    for await (const item of events) received.push(item);
    expect(received).toEqual([first, last]);
  });

  test("still rejects a genuinely truncated event rather than silently dropping it", async () => {
    const thread = await fakeCli('{"type":"item.completed","item":');
    const { events } = await thread.runStreamed("check");
    await expect(
      (async () => {
        for await (const _ of events) {
        }
      })(),
    ).rejects.toThrow("Failed to parse item");
  });

  test("still reports a CLI failure after valid events", async () => {
    const thread = await fakeCli(`${JSON.stringify(completed("partial"))}\n`, undefined, 7);
    const { events } = await thread.runStreamed("check");
    await expect(
      (async () => {
        for await (const _ of events) {
        }
      })(),
    ).rejects.toThrow("Codex Exec exited with code 7");
  });
});
