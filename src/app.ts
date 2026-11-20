import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../package.json";
import { Admin } from "./agent/admin.ts";
import { Cleanup } from "./agent/cleanup.ts";
import { createMessageHandler } from "./agent/inbox.ts";
import { RecoveryStore } from "./agent/recovery.ts";
import { Scheduler } from "./agent/scheduler.ts";
import { ScheduleRunner } from "./agent/schedules.ts";
import { createTurnRunner, RESTARTED_REPLY } from "./agent/turn.ts";
import { API_STATE_KEY, createApiChat } from "./api/channel.ts";
import { EventHub } from "./api/events.ts";
import { startApiServer } from "./api/server.ts";
import { configuredChannelNames, connectChannels } from "./channels/adapters.ts";
import { Channels } from "./channels/registry.ts";
import { buildThreadOptions, createCodex, deleteCodexThread, resolveCodexPath } from "./codex.ts";
import { codexAuthStatus, ensureCodexLogin } from "./codex-login.ts";
import { type ApiConfig, type Config, ConfigError } from "./config/index.ts";
import { type AppLifecycle, runWithLifecycle } from "./lifecycle.ts";
import { createMemoryTools } from "./mcp/memory-tools.ts";
import { type McpEndpoint, startMcpServer } from "./mcp/server.ts";
import { createTodoTools } from "./mcp/todo-tools.ts";
import { ApiSessionStore } from "./state/api-sessions.ts";
import {
  MessageQueue,
  openStateDb,
  ScheduleStore,
  SessionStore,
  UsageStore,
} from "./state/index.ts";
import { MemoryStore } from "./state/memory.ts";
import { TodoStore } from "./state/todos.ts";
import { DAY_MS, MINUTE_MS } from "./util/time.ts";

export interface StartOptions {
  configPath: string;
  /** Validate everything and print the summary, but do not connect to Slack or Telegram. */
  dryRun?: boolean;
}

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
    ["channels", configuredChannelNames(config.channels).join(", ") || "(none)"],
    ["api", describeApi(config.api)],
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
    console.log("dry run: config OK, not connecting to chat services");
    return;
  }

  await runWithLifecycle(async ({ signal, defer }) => {
    // Without CODEX_API_KEY or a saved login, log a device code and wait for someone to sign in.
    await ensureCodexLogin({ codexPath, signal });
    signal.throwIfAborted();

    // Connect-time checks (tokens) for every configured channel, before anything starts.
    const chatChannels = await connectChannels(config.channels, signal);
    // One database per agent, named after its bot, so several agents can share a state directory.
    // An agent without a chat service is named after its API.
    const dbPath = join(stateDir, `${chatChannels[0]?.stateKey ?? API_STATE_KEY}.sqlite`);
    const db = openStateDb(dbPath);
    defer("state database", () => db.$client.close());
    // The HTTP API is a channel too: its chat sessions run through the same queue and turns.
    const hub = new EventHub();
    const apiSessions = new ApiSessionStore(db);
    const api = config.api.enabled
      ? createApiChat({ hub, sessions: apiSessions, workspace })
      : undefined;
    const channels = new Channels(api ? [...chatChannels, api.channel] : chatChannels);
    const sessions = new SessionStore(db);
    const queue = new MessageQueue(db);
    const schedules = new ScheduleStore(db);
    const usage = new UsageStore(db);
    const sessionIdleMs = sessionIdleDays * DAY_MS;
    // Set once the MCP server is up (it needs the scheduler, which needs this to start turns).
    let mcp: McpEndpoint | undefined;

    const runTurn = createTurnRunner({
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
      turnTimeoutMs: turnTimeoutMinutes * MINUTE_MS,
      sessionIdleMs,
      onEvent: api?.onCodexEvent,
    });
    const scheduler = new Scheduler(queue, api ? api.observe(runTurn) : runTurn, {
      maxConcurrent,
      maxQueue,
      onError: (err, m) => console.warn(`turn for ${m.conversationKey} failed: ${err}`),
    });

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
    const memories = new MemoryStore(db);
    const todos = new TodoStore(db);
    const toolGroups = [
      createMemoryTools(memories),
      createTodoTools(todos),
      ...channels.all.flatMap((channel) =>
        channel.registerMcpTools ? [channel.registerMcpTools] : [],
      ),
    ];
    mcp = startMcpServer(
      admin,
      (turnId) => {
        const turn = scheduler.runningTurns().find((t) => t.message.id === turnId);
        if (!turn) return null;
        const { user, channel, conversationKey, ts } = turn.message;
        return { user, channel, conversationKey, messageTs: ts || undefined, workspace };
      },
      toolGroups,
    );

    defer("MCP server", mcp.stop);
    defer("scheduler", () => scheduler.stop());

    await reportInterrupted(queue, channels);

    if (api) {
      const endpoint = listen(config.api, () =>
        startApiServer({
          ...config.api,
          workspace,
          admin,
          scheduler,
          queue,
          sessions,
          apiSessions,
          hub,
          todos,
          memories,
          info: {
            name: "elseagent",
            version: pkg.version,
            model: threadOptions.model ?? null,
            reasoningEffort: threadOptions.modelReasoningEffort ?? null,
            workspace,
            timezone,
            channels: channels.all.map((channel) => channel.label),
          },
        }),
      );
      defer("API server", endpoint.stop);
      console.log(`api: listening on ${endpoint.url}`);
    }

    const onMessage = createMessageHandler({ scheduler, sessions });

    for (const channel of chatChannels) {
      signal.throwIfAborted();
      defer(channel.label, () => channel.stop());
      await channel.start(async (message, reply) => {
        if (!signal.aborted) await onMessage(message, reply);
      });
      signal.throwIfAborted();
      console.log(`${channel.label}: connected`);
    }
    console.log(`state: ${dbPath}`);
    scheduler.pump(); // pick up messages still queued from before a restart

    every(defer, "session expiry timer", 60 * MINUTE_MS, () => {
      const removed = sessions.expire(sessionIdleMs);
      if (removed) console.log(`sessions: forgot ${removed} idle conversation(s)`);
    });
    // Queue scheduled tasks when they are due (also catches up once after a restart).
    every(defer, "schedule timer", MINUTE_MS / 2, () => {
      try {
        scheduleRunner.tick((schedule, err) =>
          console.warn(`schedule #${schedule.id} "${schedule.name}": ${err}`),
        );
      } catch (err) {
        console.warn(`could not check due schedules: ${err}`);
      }
    });
  });
}

const describeApi = ({ enabled, host, port, token }: ApiConfig) =>
  enabled ? `http://${host}:${port}/api (${token ? "token required" : "no token"})` : "off";

/** Start the API server; a port that can't be used is a config problem, said plainly. */
function listen<T>({ host, port }: ApiConfig, start: () => T): T {
  try {
    return start();
  } catch (err) {
    throw new ConfigError(
      `api: could not listen on ${host}:${port} (${(err as Error).message}). ` +
        "Set api.port to a free port, or api.enabled to false.",
    );
  }
}

/** Run `task` now and then every `intervalMs`, until shutdown. */
function every(
  defer: AppLifecycle["defer"],
  name: string,
  intervalMs: number,
  task: () => void,
): void {
  task();
  const timer = setInterval(task, intervalMs);
  defer(name, () => clearInterval(timer));
}

/** Tell the users whose messages were mid-turn when the previous process stopped. */
async function reportInterrupted(queue: MessageQueue, channels: Channels): Promise<void> {
  for (const message of queue.takeInterrupted()) {
    try {
      const reply = channels.replyTo(message);
      if (message.scheduleId !== null) {
        await reply
          .post(`A scheduled task (#${message.scheduleId}) was interrupted by a restart.`)
          .catch(() => {});
        continue;
      }
      await reply.unreact("working");
      await reply.react("failed");
      await reply.post(RESTARTED_REPLY).catch(() => {});
    } catch (err) {
      console.warn(`could not report an interrupted turn: ${(err as Error).message}`);
    }
  }
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
