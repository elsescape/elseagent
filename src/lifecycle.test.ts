import { expect, test } from "bun:test";
import { runWithLifecycle } from "./lifecycle.ts";

test("a failed channel start still closes every resource and keeps the startup error", async () => {
  const closed: string[] = [];
  const startError = new Error("channel could not start");
  await expect(
    runWithLifecycle(async ({ defer }) => {
      for (const name of ["database", "MCP", "scheduler", "first channel"]) {
        defer(name, () => closed.push(name));
      }
      defer("second channel", async () => {
        closed.push("second channel");
        throw new Error("channel could not stop");
      });
      throw startError;
    }),
  ).rejects.toBe(startError);
  expect(closed).toEqual(["second channel", "first channel", "scheduler", "MCP", "database"]);
});

test("a signal during startup aborts startup and closes acquired resources", async () => {
  const closed: string[] = [];
  const listeners = process.listenerCount("SIGTERM");
  await runWithLifecycle(async ({ signal, defer }) => {
    defer("channel", () => closed.push("channel"));
    process.emit("SIGTERM", "SIGTERM");
    signal.throwIfAborted();
  });
  expect(closed).toEqual(["channel"]);
  expect(process.listenerCount("SIGTERM")).toBe(listeners);
});
