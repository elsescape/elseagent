import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SessionStore } from "../state/index.ts";
import { formatSize } from "../util/text.ts";
import { DAY_MS } from "../util/time.ts";
import { attachmentsDir } from "./files.ts";

export interface CleanupDeps {
  sessions: Pick<
    SessionStore,
    "idleSince" | "deleteSessions" | "unusedThreads" | "dropThread" | "conversationKeys"
  >;
  /** Conversations with a queued or running message: never cleaned up. */
  busyConversations(): string[];
  /** Delete a Codex thread from Codex's own storage (see `deleteCodexThread`). */
  deleteThread(threadId: string): Promise<void>;
  workspace: string;
  now?: () => number;
}

/** Total size of the files under a directory. */
async function sizeOf(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) total += Bun.file(join(entry.parentPath, entry.name)).size;
  }
  return total;
}

/**
 * Removes what idle conversations leave behind: their sessions, the Codex threads no conversation
 * uses any more (deleted from Codex's storage), and attachment folders. A conversation that
 * becomes active again simply starts a new Codex session.
 */
export class Cleanup {
  private readonly now: () => number;

  constructor(private readonly deps: CleanupDeps) {
    this.now = deps.now ?? Date.now;
  }

  async run({ olderThanDays, dryRun }: { olderThanDays: number; dryRun: boolean }) {
    const { sessions, workspace } = this.deps;
    const cutoff = this.now() - olderThanDays * DAY_MS;
    const busy = this.deps.busyConversations();

    const idle = sessions.idleSince(cutoff, busy);
    if (!dryRun) sessions.deleteSessions(idle.map((s) => s.conversationKey));
    const idleKeys = new Set(idle.map((s) => s.conversationKey));

    // On a dry run the idle sessions still map their threads: count those too.
    const threads = new Map(sessions.unusedThreads(cutoff).map((t) => [t.threadId, t]));
    if (dryRun) {
      for (const s of idle) {
        if (s.threadId) threads.set(s.threadId, { ...s });
      }
    }
    let threadsDeleted = 0;
    const threadErrors: { threadId: string; error: string }[] = [];
    for (const { threadId } of threads.values()) {
      if (dryRun) continue;
      try {
        await this.deps.deleteThread(threadId);
        sessions.dropThread(threadId);
        threadsDeleted++;
      } catch (err) {
        threadErrors.push({ threadId, error: (err as Error).message });
      }
    }

    // Attachment folders of conversations without a session, untouched since the cutoff.
    const live = new Set(
      [...sessions.conversationKeys().filter((k) => !idleKeys.has(k)), ...busy].map((k) =>
        attachmentsDir(workspace, k),
      ),
    );
    const root = join(workspace, "attachments");
    const folders: string[] = [];
    let bytes = 0;
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      const dir = join(root, entry.name);
      if (!entry.isDirectory() || live.has(dir)) continue;
      const info = await stat(dir).catch(() => null);
      if (!info || info.mtimeMs >= cutoff) continue;
      bytes += await sizeOf(dir).catch(() => 0);
      folders.push(entry.name);
      if (!dryRun) await rm(dir, { recursive: true, force: true });
    }

    return {
      dryRun,
      olderThanDays,
      sessions: idle.length,
      conversations: idle.slice(0, 20).map((s) => s.conversationKey),
      codexThreads: dryRun ? threads.size : threadsDeleted,
      ...(threadErrors.length ? { codexThreadErrors: threadErrors.slice(0, 20) } : {}),
      attachmentFolders: folders.length,
      attachmentBytes: formatSize(bytes),
    };
  }
}
