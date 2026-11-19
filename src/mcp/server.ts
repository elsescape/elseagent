import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Admin, Caller } from "../agent/admin.ts";
import { registerGeneralTools } from "./general-tools.ts";
import type { ToolGroup } from "./tools.ts";

/** Header carrying the queue message id of the turn that makes the call. */
export const TURN_HEADER = "x-elseagent-turn";
/** Environment variable through which Codex receives the bearer token. */
export const TOKEN_ENV = "ELSEAGENT_MCP_TOKEN";

export interface McpEndpoint {
  url: string;
  token: string;
  stop(): Promise<void>;
}

/** The elseagent tools, bound to the caller of one request. */
function buildMcpServer(admin: Admin, caller: Caller, groups: readonly ToolGroup[]): McpServer {
  const server = new McpServer({ name: "elseagent", version: "1.0.0" });
  registerGeneralTools(server, admin, caller);
  for (const register of groups) register(server, admin, caller);
  return server;
}

/**
 * Serve the elseagent tools over MCP (streamable HTTP) on 127.0.0.1, for this process's Codex
 * turns only: requests need the bearer token and the id of a turn that is running.
 */
export function startMcpServer(
  admin: Admin,
  callerFor: (turnId: number) => Caller | null,
  groups: readonly ToolGroup[] = [],
): McpEndpoint {
  const token = crypto.randomUUID();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== `Bearer ${token}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const caller = callerFor(Number(req.headers.get(TURN_HEADER)));
      if (!caller) return new Response("unknown or finished turn", { status: 403 });
      // Stateless: a fresh server and transport per request.
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await buildMcpServer(admin, caller, groups).connect(transport);
      return transport.handleRequest(req);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    token,
    stop: () => server.stop(true),
  };
}
