import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Thread, ThreadEvent } from "@openai/codex-sdk";
import { InterruptedStreamError, RecoveryStore, recoveryInput } from "./recovery.ts";
import { runStreamed } from "./turn.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function stream(events: ThreadEvent[], error?: Error): Pick<Thread, "runStreamed"> {
  return {
    async runStreamed() {
      return {
        events: (async function* () {
          yield* events;
          if (error) throw error;
        })(),
      };
    },
  } as Pick<Thread, "runStreamed">;
}

const done: ThreadEvent = {
  type: "turn.completed",
  usage: {
    input_tokens: 1,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 1,
    reasoning_output_tokens: 0,
  },
};
const command = {
  id: "cmd",
  type: "command_execution" as const,
  command: "some command",
  aggregated_output: "",
  status: "in_progress" as const,
};

describe("failure boundaries", () => {
  test("failed tool results do not terminate the model's turn", async () => {
    const thread = stream([
      { type: "item.started", item: command },
      { type: "item.completed", item: { ...command, status: "failed", exit_code: 1 } },
      {
        type: "item.completed",
        item: {
          id: "api",
          type: "mcp_tool_call",
          server: "test",
          tool: "read",
          arguments: {},
          status: "failed",
          error: { message: "site unavailable" },
        },
      },
      {
        type: "item.completed",
        item: {
          id: "reply",
          type: "agent_message",
          text: "Skipped the failed item and continued.",
        },
      },
      done,
    ]);
    const result = await runStreamed(thread, "check", {}, () => {});
    expect(result.finalResponse).toBe("Skipped the failed item and continued.");
  });

  test("premature EOF retains unconfirmed operations instead of returning empty success", async () => {
    try {
      await runStreamed(stream([{ type: "item.started", item: command }]), "check", {}, () => {});
      throw new Error("expected interruption");
    } catch (error) {
      expect(error).toBeInstanceOf(InterruptedStreamError);
      expect((error as InterruptedStreamError).pending).toEqual([
        { id: "cmd", type: "command_execution" },
      ]);
    }
  });

  test("confirmed tool results are removed from the uncertainty list", async () => {
    try {
      await runStreamed(
        stream(
          [
            { type: "item.started", item: command },
            { type: "item.completed", item: { ...command, status: "completed", exit_code: 0 } },
          ],
          new Error("connection lost"),
        ),
        "check",
        {},
        () => {},
      );
      throw new Error("expected interruption");
    } catch (error) {
      expect(error).toBeInstanceOf(InterruptedStreamError);
      expect((error as InterruptedStreamError).pending).toEqual([]);
    }
  });

  test("checkpoints survive a new store instance and clear explicitly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "elseagent-recovery-"));
    dirs.push(dir);
    const checkpoint = {
      threadId: "session-1",
      pending: [{ id: "write", type: "mcp_tool_call" }],
      at: new Date().toISOString(),
    };
    await new RecoveryStore(dir).save("channel:thread", checkpoint);
    const restarted = new RecoveryStore(dir);
    expect(await restarted.get("channel:thread")).toEqual(checkpoint);
    await restarted.clear("channel:thread");
    expect(await restarted.get("channel:thread")).toBeNull();
  });

  test("recovery instructions preserve image inputs and prohibit blind replay", () => {
    const input = recoveryInput(
      [
        { type: "text", text: "continue" },
        { type: "local_image", path: "/tmp/photo.png" },
      ],
      [{ id: "write", type: "mcp_tool_call" }],
    );
    expect(input).toContainEqual({ type: "local_image", path: "/tmp/photo.png" });
    expect(JSON.stringify(input)).toContain("Do not repeat");
  });
});
