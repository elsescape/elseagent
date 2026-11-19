import { homedir } from "node:os";
import { join } from "node:path";
import { Codex, type CodexOptions, type ThreadOptions } from "@openai/codex-sdk";
import { buildInstructions } from "./agent/instructions.ts";
import { type CodexConfig, ConfigError } from "./config/index.ts";
import { TOKEN_ENV, TURN_HEADER } from "./mcp/server.ts";

/** Codex features turned off for every turn (same as `codex --disable plugins --disable apps`). */
export const DISABLED_FEATURES = { plugins: false, apps: false } as const;

/**
 * Agent-mode settings: act autonomously, never stop to ask. Codex's sandbox keeps commands'
 * writes inside the workspace unless `codex.sandboxMode` says otherwise (the Docker images turn
 * it off: the container is the sandbox).
 */
export const AGENT_THREAD_DEFAULTS = {
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
  skipGitRepoCheck: true,
} as const satisfies ThreadOptions;

/** Options for every Codex thread: agent-mode defaults plus the user's overrides. */
export function buildThreadOptions(config: CodexConfig, workingDirectory: string): ThreadOptions {
  return {
    ...AGENT_THREAD_DEFAULTS,
    sandboxMode: config.sandboxMode ?? AGENT_THREAD_DEFAULTS.sandboxMode,
    workingDirectory,
    model: config.model,
    modelReasoningEffort: config.reasoningEffort,
  };
}

/** How a turn reaches the elseagent MCP tools served by this process. */
export interface McpRegistration {
  url: string;
  token: string;
  /** Queue message id of the turn; tells the tools who is calling. */
  turnId: number;
}

export interface CodexClientOptions {
  codexPath: string;
  /** The agent's role (`prompt` in the config). */
  prompt?: string;
  /** Instructions of the channel the conversation is in (`Channel.instructions`). */
  channelInstructions?: string;
  /** Registers the elseagent MCP server for this turn. */
  mcp?: McpRegistration;
}

/**
 * Codex options for one turn. The built-in agent instructions, the channel's and the agent prompt become
 * Codex's `developer_instructions` (on top of Codex's own system prompt). With `mcp`, the
 * elseagent MCP server is registered; its tools are trusted, so they run without approval
 * (with `approvalPolicy: never`, anything needing approval would be refused).
 */
export function buildCodexOptions({
  codexPath,
  prompt,
  channelInstructions,
  mcp,
}: CodexClientOptions): CodexOptions {
  const config: NonNullable<CodexOptions["config"]> = {
    developer_instructions: buildInstructions({ channel: channelInstructions, prompt }),
    // No ChatGPT apps (Gmail, Drive… connected to the Codex login's account) and no Codex
    // plugins: the agent only gets the tools we give it. MCP servers configured here, like
    // elseagent's own, are not affected.
    features: DISABLED_FEATURES,
  };
  // The commands Codex runs inherit this process's environment (tool credentials such as
  // GH_TOKEN), but never the MCP token.
  if (!mcp) return { codexPathOverride: codexPath, config };
  config.shell_environment_policy = { exclude: [TOKEN_ENV] };
  config.mcp_servers = {
    elseagent: {
      url: mcp.url,
      // The token travels in the environment, not on the command line, and is excluded
      // from the commands' environment above.
      bearer_token_env_var: TOKEN_ENV,
      http_headers: { [TURN_HEADER]: String(mcp.turnId) },
      default_tools_approval_mode: "approve",
    },
  };
  return {
    codexPathOverride: codexPath,
    config,
    // Setting `env` replaces the inherited environment, so pass it along.
    env: { ...(process.env as Record<string, string>), [TOKEN_ENV]: mcp.token },
  };
}

/**
 * Find the codex CLI: `codex.path` (absolute path or command name) or `codex` on PATH. The
 * bundled @openai/codex binary is never used: elseagent ships as a single file without
 * node_modules, so source and compiled builds behave the same.
 */
export function resolveCodexPath(config: CodexConfig, searchPath = process.env.PATH): string {
  const command = config.path ?? "codex";
  const resolved = Bun.which(command, { PATH: searchPath });
  if (!resolved) {
    throw new ConfigError(
      config.path
        ? `codex.path not found or not executable: ${config.path}`
        : "Could not find `codex` on PATH. Install it (e.g. `npm i -g @openai/codex`) " +
            "or set codex.path in the config.",
    );
  }
  return resolved;
}

/** A Codex client for one turn. */
export function createCodex(options: CodexClientOptions): Codex {
  return new Codex(buildCodexOptions(options));
}

/** Codex's data directory: `CODEX_HOME`, or ~/.codex. */
export const codexHome = (env: Record<string, string | undefined> = process.env) =>
  env.CODEX_HOME || join(homedir(), ".codex");

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The file Codex keeps a thread's history in (its rollout), or null when it has none. A
 * compressed archive counts with `anyFormat`; only plain `.jsonl` can be read as it is.
 */
export async function rolloutPath(
  threadId: string,
  home = codexHome(),
  anyFormat = false,
): Promise<string | null> {
  if (!THREAD_ID.test(threadId)) return null;
  const glob = new Bun.Glob(`**/rollout-*-${threadId}.jsonl${anyFormat ? "*" : ""}`);
  for (const dir of ["sessions", "archived_sessions"]) {
    try {
      const cwd = join(home, dir);
      for await (const file of glob.scan({ cwd, onlyFiles: true })) return join(cwd, file);
    } catch {
      // no such directory
    }
  }
  return null;
}

/** Whether Codex still has a saved session (rollout file) for a thread. */
export async function hasRollout(threadId: string, home = codexHome()): Promise<boolean> {
  return (await rolloutPath(threadId, home, true)) !== null;
}

/**
 * Delete a Codex thread from Codex's storage with `codex delete --force`. A thread that is
 * already gone counts as deleted.
 */
export async function deleteCodexThread(
  codexPath: string,
  threadId: string,
  home = codexHome(),
): Promise<void> {
  if (!THREAD_ID.test(threadId)) throw new Error(`not a Codex thread id: ${threadId}`);
  const proc = Bun.spawn([codexPath, "delete", "--force", threadId], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code === 0 || !(await hasRollout(threadId, home))) return;
  throw new Error(stderr.trim() || `codex delete exited with code ${code}`);
}
