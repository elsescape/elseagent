import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Admin } from "./agent/admin.ts";
import { Cleanup } from "./agent/cleanup.ts";
import { createMessageHandler } from "./agent/inbox.ts";
import { RecoveryStore } from "./agent/recovery.ts";
import { Scheduler } from "./agent/scheduler.ts";
import { ScheduleRunner } from "./agent/schedules.ts";
import { createTurnRunner, REACTIONS } from "./agent/turn.ts";
import { Channels } from "./channels/registry.ts";
import { createSlackBot } from "./channels/slack/index.ts";
import { createTelegramBot } from "./channels/telegram/index.ts";
import type { Channel } from "./channels/types.ts";
import { buildThreadOptions, createCodex, deleteCodexThread, resolveCodexPath } from "./codex.ts";
import { codexAuthStatus, ensureCodexLogin } from "./codex-login.ts";
import { type Config, ConfigError } from "./config/index.ts";
import { type McpEndpoint, startMcpServer } from "./mcp/server.ts";
import {
  MessageQueue,
  openStateDb,
  ScheduleStore,
  SessionStore,
  UsageStore,
} from "./state/index.ts";

export interface StartOptions {
  configPath: string;
  /** Validate everything and print the summary, but do not connect to Slack or Telegram. */
  dryRun?: boolean;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Start the agent with a validated config. */
export async function startApp(
  config: Config,
  { configPath, dryRun = false }: StartOptions,
): Promise<void> {
  const { workspace } = config;
  const workspaceState = await ensureWorkspace(workspace, dryRun);
  // Codex reads CODEX_API_KEY. Credentials for the tools Codex runs (GH_TOKEN…) are plain
  // environment variables of this process (the container's), inherited by Codex and its commands.
  if (config.codex.apiKey) process.env.CODEX_API_KEY = config.codex.apiKey;
  // Resolve the codex binary up front so a missing CLI fails at startup, not on the first message.
  const codexPath = resolveCodexPath(config.codex);
  const threadOptions = buildThreadOptions(config.codex, workspace);

  const {
    prompt,
    maxConcurrent,
    maxQueue,
    turnTimeoutMinutes,
    sessionIdleDays,
    stateDir,
    timezone,
  } = config;
  printSummary([
    ["config", configPath],
    ["workspace", workspaceState === "missing" ? `${workspace} (will be created)` : workspace],
    ["state directory", stateDir],
    ["model", threadOptions.model ?? "(codex default)"],
    ["reasoning effort", threadOptions.modelReasoningEffort ?? "(codex default)"],
    ["prompt", prompt ? `${prompt.length} chars` : "(none)"],
    ["time zone", timezone],
    [
      "channels",
      [config.channels.slack && "slack", config.channels.telegram && "telegram"]
        .filter(Boolean)
        .join(", "),
    ],
    [
      "limits",
      `${maxConcurrent} concurrent, queue ${maxQueue}, ` +
        `turn timeout ${turnTimeoutMinutes}m, session idle ${sessionIdleDays}d`,
    ],
  ]);
  if (dryRun) {
    const auth = await codexAuthStatus(codexPath);
    console.log(
      `codex auth: ${auth}${auth === "not-logged-in" ? " (run would start device-code login)" : ""}`,
    );
    console.log("dry run: config OK, not connecting to Slack or Telegram");
    return;
  }

  // Without CODEX_API_KEY or a saved login, log a device code and wait for someone to sign in.
  await ensureCodexLogin({ codexPath });

  // Connect-time checks (tokens) for every configured channel, before anything starts.
  const slack = config.channels.slack ? await createSlackBot(config.channels.slack) : undefined;
  const telegram = config.channels.telegram
    ? await createTelegramBot(config.channels.telegram)
    : undefined;
  const channels = new Channels([slack, telegram].filter((c) => c !== undefined));
  // One database per agent, named after its bot, so several agents can share a state directory.
  const dbName = slack
    ? `${slack.identity.teamId}-${slack.identity.userId}`
    : `telegram-${telegram?.identity.id}`;
  const dbPath = join(stateDir, `${dbName}.sqlite`);
  const db = openStateDb(dbPath);
  const sessions = new SessionStore(db);
  const queue = new MessageQueue(db);
  const schedules = new ScheduleStore(db);
  const usage = new UsageStore(db);
  const sessionIdleMs = sessionIdleDays * DAY;
  // Set once the MCP server is up (it needs the scheduler, which needs this to start turns).
  let mcp: McpEndpoint | undefined;

  const scheduler = new Scheduler(
    queue,
    createTurnRunner({
      codexFor: (message) =>
        createCodex({
          codexPath,
          prompt,
          channelInstructions: channels.for(message.channel).instructions,
          mcp: mcp && { url: mcp.url, token: mcp.token, turnId: message.id },
        }),
      sessions,
      recovery: new RecoveryStore(join(stateDir, "recovery")),
      queue,
      threadOptions,
      replyTo: channels.replyTo,
      threadContext: channels.threadContext,
      download: channels.download,
      usage,
      turnTimeoutMs: turnTimeoutMinutes * MINUTE,
      sessionIdleMs,
    }),
    {
      maxConcurrent,
      maxQueue,
      onError: (err, m) => console.warn(`turn for ${m.conversationKey} failed: ${err}`),
    },
  );

  const scheduleRunner = new ScheduleRunner(schedules, scheduler);
  const admin = new Admin({
    scheduler,
    queue,
    sessions,
    schedules,
    scheduleRunner,
    usage,
    cleanup: new Cleanup({
      sessions,
      busyConversations: () => queue.conversations(),
      deleteThread: (threadId) => deleteCodexThread(codexPath, threadId),
      workspace,
    }),
    ensureChannel: channels.ensureChannel,
    limits: { maxConcurrent, maxQueue, turnTimeoutMinutes, sessionIdleDays },
    defaultTimezone: timezone,
  });
  // The elseagent tools, registered with every Codex turn (see buildCodexOptions).
  mcp = startMcpServer(admin, (turnId) => {
    const turn = scheduler.runningTurns().find((t) => t.message.id === turnId);
    if (!turn) return null;
    const { user, channel, conversationKey } = turn.message;
    return { user, channel, conversationKey };
  });

  // Messages that were mid-turn when the previous process stopped.
  for (const message of queue.takeInterrupted()) {
    try {
      const reply = channels.replyTo(message);
      if (message.scheduleId !== null) {
        await reply
          .post(`A scheduled task (#${message.scheduleId}) was interrupted by a restart.`)
          .catch(() => {});
        continue;
      }
      await reply.unreact(REACTIONS.working);
      await reply.react(REACTIONS.failed);
      await reply
        .post("The agent restarted while working on this. Send it again to retry.")
        .catch(() => {});
    } catch (err) {
      console.warn(`could not report an interrupted turn: ${(err as Error).message}`);
    }
  }

  const onMessage = createMessageHandler({ scheduler, sessions });

  const started: Channel[] = [];
  for (const channel of channels.all) {
    await channel.start(onMessage);
    started.push(channel);
    console.log(`${channel.label}: connected`);
  }
  console.log(`state: ${dbPath}`);
  scheduler.pump(); // pick up messages still queued from before a restart

  const expireSessions = () => {
    const removed = sessions.expire(sessionIdleMs);
    if (removed) console.log(`sessions: forgot ${removed} idle conversation(s)`);
  };
  expireSessions();
  const gc = setInterval(expireSessions, 60 * MINUTE);

  // Queue scheduled tasks when they are due (also catches up once after a restart).
  const runDueSchedules = () =>
    scheduleRunner.tick((schedule, err) =>
      console.warn(`schedule #${schedule.id} "${schedule.name}": ${(err as Error).message}`),
    );
  runDueSchedules();
  const ticker = setInterval(runDueSchedules, 30_000);

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, stopping`);
    clearInterval(gc);
    clearInterval(ticker);
    await Promise.all(started.map((c) => c.stop())); // no new messages
    await scheduler.stop(); // abort running turns; they tell their threads
    await mcp?.stop();
    db.$client.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

/**
 * Make sure the workspace is a directory, creating it if missing (except on a dry run).
 * Returns whether it existed.
 */
async function ensureWorkspace(path: string, dryRun: boolean): Promise<"exists" | "missing"> {
  const stats = await stat(path).catch(() => null);
  if (stats && !stats.isDirectory()) {
    throw new ConfigError(`workspace is not a directory: ${path}`);
  }
  if (stats) return "exists";
  if (!dryRun) await mkdir(path, { recursive: true });
  return "missing";
}

function printSummary(rows: [label: string, value: string][]): void {
  const width = Math.max(...rows.map(([label]) => label.length)) + 1;
  console.log("elseagent starting");
  for (const [label, value] of rows) {
    console.log(`  ${`${label}:`.padEnd(width)} ${value}`);
  }
}
