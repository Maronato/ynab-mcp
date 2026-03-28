import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { extractErrorMessage } from "../ynab/errors.js";

export function registerUndoTools(
  server: McpServer,
  context: AppContext,
): void {
  const listUndoHistorySchema = z.object({
    budget_id: z
      .string()
      .optional()
      .describe("Budget ID. Omit to use the last-used budget."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(20)
      .describe("Maximum entries to return. Defaults to 20."),
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

  server.registerTool(
    "list_undo_history",
    {
      title: "List Undo History",
      description: "List undoable operations for a budget.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: listUndoHistorySchema,
    },
    async (input) => {
      try {
        const includeUndone = input.include_undone ?? false;
        const limit = input.limit ?? 20;
        const resolvedBudgetId = await context.ynabClient.resolveRealBudgetId(
          input.budget_id,
        );
        const entries = await context.undoEngine.listHistory(
          resolvedBudgetId,
          limit,
          includeUndone,
        );

        return jsonToolResult({
          budget_id: resolvedBudgetId,
          count: entries.length,
          entries: entries.map((entry) => ({
            id: entry.id,
            timestamp: entry.timestamp,
            operation: entry.operation,
            description: entry.description,
            status: entry.status,
          })),
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to list undo history."),
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
          input.force ?? false,
        );

        return jsonToolResult(result);
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to undo operations."),
        );
      }
    },
  );
}
