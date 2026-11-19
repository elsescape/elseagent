import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type Admin, AdminError, type Caller } from "../agent/admin.ts";

/** Registers one family of tools for the current caller. */
export type ToolGroup = (server: McpServer, admin: Admin, caller: Caller) => void;

const text = (value: unknown): CallToolResult => ({
  content: [
    { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
  ],
});

/** Run a tool, turning AdminError into a tool error Codex can read and react to. */
export async function callTool(fn: () => unknown): Promise<CallToolResult> {
  try {
    return text(await fn());
  } catch (err) {
    if (err instanceof AdminError) return { ...text(err.message), isError: true };
    throw err;
  }
}
