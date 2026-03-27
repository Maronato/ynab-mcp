import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";

const listUndoHistorySchema = z.object({
  budget_id: z.string().optional(),
  session: z.enum(["current", "all"]).default("current"),
  limit: z.number().int().min(1).max(200).default(20),
  include_undone: z.boolean().default(false),
});

const undoOperationsSchema = z.object({
  undo_history_ids: z
    .array(z.string())
    .min(1)
    .describe(
      "The undo entry IDs to undo (returned as undo_history_ids by write tools).",
    ),
  force: z.boolean().default(false),
});

export function registerUndoTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "list_undo_history",
    {
      title: "List Undo History",
      description:
        "List undoable operations with optional session scoping (current session or all sessions).",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: listUndoHistorySchema,
    },
    async (input) => {
      try {
        const resolvedBudgetId = await context.ynabClient.resolveRealBudgetId(
          input.budget_id,
        );
        const entries = await context.undoEngine.listHistory(
          resolvedBudgetId,
          input.session,
          input.limit,
          input.include_undone,
        );
        const currentSessionId = context.undoEngine.getSessionId();

        return jsonToolResult({
          budget_id: resolvedBudgetId,
          session_scope: input.session,
          current_session_id: currentSessionId,
          count: entries.length,
          entries: entries.map((entry) => ({
            id: entry.id,
            session_id: entry.session_id,
            is_current_session: entry.session_id === currentSessionId,
            timestamp: entry.timestamp,
            operation: entry.operation,
            description: entry.description,
            status: entry.status,
          })),
        });
      } catch (error) {
        return errorToolResult(
          error instanceof Error
            ? error.message
            : "Failed to list undo history.",
        );
      }
    },
  );

  server.registerTool(
    "undo_operations",
    {
      title: "Undo Operations",
      description:
        "Undo one or more prior operations with conflict detection. Use force=true to override conflicts.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: undoOperationsSchema,
    },
    async (input) => {
      try {
        const result = await context.undoEngine.undoOperations(
          input.undo_history_ids,
          input.force,
        );

        return jsonToolResult(result);
      } catch (error) {
        return errorToolResult(
          error instanceof Error ? error.message : "Failed to undo operations.",
        );
      }
    },
  );
}
