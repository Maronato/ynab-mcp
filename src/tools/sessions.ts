import { randomUUID } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppContext } from "../context.js";
import { jsonToolResult } from "../shared/mcp.js";

export function registerSessionTools(
  server: McpServer,
  _context: AppContext,
): void {
  server.registerTool(
    "setup_session",
    {
      title: "Setup Session",
      description:
        "Create and return a new session ID for session-scoped undo.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      return jsonToolResult({
        session_id: randomUUID(),
      });
    },
  );
}
