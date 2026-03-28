import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { DEFAULT_SESSION_ID, sessionIdSchema } from "../shared/session.js";
import { extractErrorMessage } from "../ynab/errors.js";

export function registerUndoTools(
  server: McpServer,
  context: AppContext,
): void {
  const listUndoHistorySchema = z.object({
    budget_id: z.string().optional(),
    session_id: sessionIdSchema(context.requireSession),
    include_all_sessions: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(20),
    include_undone: z.boolean().default(false),
  });

  const undoOperationsSchema = z.object({
    session_id: sessionIdSchema(context.requireSession),
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
      description:
        "List undoable operations for a session, or include all sessions when requested.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
      inputSchema: listUndoHistorySchema,
    },
    async (input) => {
      try {
        const sessionId = input.session_id ?? DEFAULT_SESSION_ID;
        const includeAllSessions = input.include_all_sessions ?? false;
        const includeUndone = input.include_undone ?? false;
        const limit = input.limit ?? 20;
        const resolvedBudgetId = await context.ynabClient.resolveRealBudgetId(
          input.budget_id,
        );
        const entries = await context.undoEngine.listHistory(
          resolvedBudgetId,
          sessionId,
          limit,
          includeUndone,
          includeAllSessions,
        );

        return jsonToolResult({
          budget_id: resolvedBudgetId,
          session_id: sessionId,
          include_all_sessions: includeAllSessions,
          count: entries.length,
          entries: entries.map((entry) => ({
            id: entry.id,
            session_id: entry.session_id,
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
        const sessionId = input.session_id ?? DEFAULT_SESSION_ID;
        const result = await context.undoEngine.undoOperations(
          input.undo_history_ids,
          sessionId,
          input.force ?? false,
        );

        return jsonToolResult({
          session_id: sessionId,
          ...result,
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to undo operations."),
        );
      }
    },
  );
}
