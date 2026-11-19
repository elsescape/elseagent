import { z } from "zod";
import { AdminError } from "../agent/admin.ts";
import { TODO_STATUSES, type TodoStore } from "../state/todos.ts";
import { callTool, type ToolGroup } from "./tools.ts";

const titleInput = z.string().trim().min(1).max(160);
const detailsInput = z.string().trim().max(2_000);

export function createTodoTools(store: TodoStore): ToolGroup {
  return (server, _admin, caller) => {
    server.registerTool(
      "todo_list",
      {
        description:
          "List the agent's shared, persistent todos. Defaults to pending and in-progress todos.",
        inputSchema: {
          status: z.enum(["active", "all", ...TODO_STATUSES]).default("active"),
          limit: z.number().int().min(1).max(50).default(20),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      ({ status, limit }) => callTool(() => store.list(status, limit)),
    );
    server.registerTool(
      "todo_create",
      {
        description:
          "Create a shared todo for work that needs to continue across sessions. Does not schedule a reminder.",
        inputSchema: { title: titleInput, details: detailsInput.default("") },
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      ({ title, details }) => callTool(() => store.create(title, details, caller)),
    );
    server.registerTool(
      "todo_update",
      {
        description:
          "Update a shared todo's title, details, or status using the version returned by todo_list.",
        inputSchema: {
          id: z.number().int().positive(),
          version: z.uuid(),
          title: titleInput.optional(),
          details: detailsInput.optional(),
          status: z.enum(TODO_STATUSES).optional(),
        },
        annotations: { destructiveHint: true, openWorldHint: false },
      },
      ({ id, version, ...patch }) =>
        callTool(() => {
          if (
            patch.title === undefined &&
            patch.details === undefined &&
            patch.status === undefined
          ) {
            throw new AdminError("Provide a title, details, or status to update.");
          }
          const updated = store.update(id, version, patch, caller);
          if (!updated)
            throw new AdminError("Todo is missing or changed. List todos again before updating.");
          return updated;
        }),
    );
  };
}
