import { z } from "zod";
import { callTool, type ToolGroup } from "../../mcp/tools.ts";

export const registerSlackTools: ToolGroup = (server, admin, caller) => {
  server.registerTool(
    "slack_thread_follow",
    {
      description:
        "Stop following a Slack thread (follow=false: only answer when mentioned there) or follow " +
        "it again (follow=true: read every reply and decide whether to answer). Use it when someone " +
        "asks you to stay out of a thread or to come back. Defaults to the current thread.",
      inputSchema: {
        follow: z.boolean(),
        conversation: z
          .string()
          .optional()
          .describe("A conversation from general_list_sessions; defaults to the current one"),
      },
      annotations: { openWorldHint: false },
    },
    ({ follow, conversation }) => callTool(() => admin.threadFollow(follow, caller, conversation)),
  );
};
