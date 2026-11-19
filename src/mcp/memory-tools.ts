import { z } from "zod";
import { AdminError } from "../agent/admin.ts";
import type { MemoryStore } from "../state/memory.ts";
import { callTool, type ToolGroup } from "./tools.ts";

const keyInput = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
  .describe("Stable lowercase key, e.g. release.report_language");
const versionInput = z.uuid().describe("Version from the latest read");
const readOnly = { readOnlyHint: true, openWorldHint: false };

export function createMemoryTools(store: MemoryStore): ToolGroup {
  return (server, _admin, caller) => {
    server.registerTool(
      "memory_search",
      {
        description:
          "Search this agent's shared memories by key or content. Omit query for recently updated entries.",
        inputSchema: {
          query: z.string().trim().min(1).max(200).optional(),
          limit: z.number().int().min(1).max(25).default(10),
        },
        annotations: readOnly,
      },
      ({ query, limit }) => callTool(() => store.search(query, limit)),
    );
    server.registerTool(
      "memory_get",
      {
        description: "Get a shared memory and its current version by exact key.",
        inputSchema: { key: keyInput },
        annotations: readOnly,
      },
      ({ key }) => callTool(() => store.get(key) ?? null),
    );
    server.registerTool(
      "memory_upsert",
      {
        description:
          "Save a durable fact, preference, or decision shared by all this agent's sessions. " +
          "Omit version to create a new key. Provide the current version to replace an existing entry.",
        inputSchema: {
          key: keyInput,
          content: z.string().trim().min(1).max(2_000),
          version: versionInput.optional(),
        },
        annotations: { destructiveHint: true, openWorldHint: false },
      },
      ({ key, content, version }) =>
        callTool(() => {
          const saved = store.upsert(key, content, version, caller);
          if (!saved)
            throw new AdminError(
              "Memory changed or already exists. Read it again before updating.",
            );
          return saved;
        }),
    );
    server.registerTool(
      "memory_delete",
      {
        description: "Delete a shared memory at the version you last read.",
        inputSchema: { key: keyInput, version: versionInput },
        annotations: { destructiveHint: true, openWorldHint: false },
      },
      ({ key, version }) =>
        callTool(() => {
          const deleted = store.delete(key, version);
          if (!deleted)
            throw new AdminError("Memory is missing or changed. Read it again before deleting.");
          return { ...deleted, deleted: true };
        }),
    );
  };
}
