import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Input } from "@openai/codex-sdk";

export interface PendingOperation {
  id: string;
  type: string;
}

/** A transport/protocol failure, distinct from a model-reported turn failure. */
export class InterruptedStreamError extends Error {
  constructor(
    cause: unknown,
    readonly pending: PendingOperation[],
    readonly completed = false,
  ) {
    super(`Codex event stream interrupted: ${String(cause)}`, { cause });
    this.name = "InterruptedStreamError";
  }
}

export class FailedTurnError extends Error {
  constructor(
    message: string,
    readonly pending: PendingOperation[],
  ) {
    super(message);
  }
}

export interface RecoveryCheckpoint {
  threadId: string;
  pending: PendingOperation[];
  at: string;
}

/** Only operation IDs/types are persisted, never commands, tool arguments or raw outputs. */
export class RecoveryStore {
  constructor(private readonly dir: string) {}

  private path(conversation: string) {
    return join(this.dir, `${createHash("sha256").update(conversation).digest("hex")}.json`);
  }

  async get(conversation: string): Promise<RecoveryCheckpoint | null> {
    try {
      return JSON.parse(await readFile(this.path(conversation), "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async save(conversation: string, checkpoint: RecoveryCheckpoint) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = this.path(conversation);
    await writeFile(`${path}.tmp`, JSON.stringify(checkpoint), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }

  async clear(conversation: string) {
    await rm(this.path(conversation), { force: true });
  }
}

/** Continue the saved session; never replay the original task as a fresh request. */
export function recoveryInput(input: Input, pending: PendingOperation[]): Input {
  const notice = [
    "Execution recovery: the previous Codex process lost its event stream. The saved session and any completed work may remain.",
    pending.length
      ? `These operations started without a confirmed result: ${pending.map((x) => `${x.type} (${x.id})`).join(", ")}.`
      : "No unfinished operation was observed, but stream loss is not proof that nothing changed.",
    "First reconcile saved session history, checkpoints and actual external state using read-only checks. Do not repeat any command, API write, message send or other side effect whose result is uncertain. If it cannot be confirmed, report the uncertainty and stop that work item; do not guess or force a retry.",
    "Continue only unfinished authorized work. In a batch, checkpoint each independent item; record an individual tool/source failure and continue other items when safe. Stop on service-wide failure. Do not restart the whole batch or claim an unverified action succeeded.",
    "Current request:",
  ].join("\n");
  return typeof input === "string"
    ? `${notice}\n${input}`
    : [{ type: "text", text: notice }, ...input];
}
