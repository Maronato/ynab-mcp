import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { recordUndoAndGetIds } from "../shared/undo-helpers.js";
import { extractErrorMessage } from "../ynab/errors.js";
import {
  asCurrency,
  asMilliunits,
  currencyToMilliunits,
  milliunitsToCurrency,
} from "../ynab/format.js";

const setCategoryTargetsSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe("Budget ID. Omit to use the last-used budget."),
  targets: z
    .array(
      z.object({
        category_id: z.string(),
        goal_target: z
          .number()
          .nullable()
          .describe(
            "Target amount in currency units (e.g. 500.00). Set to null to attempt removal.",
          ),
        goal_target_date: z
          .string()
          .nullable()
          .optional()
          .describe("Target date in YYYY-MM-DD format. Set to null to clear."),
      }),
    )
    .min(1)
    .max(50),
});

export function registerTargetTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "set_category_targets",
    {
      title: "Set Category Targets",
      description:
        "Create or update targets on one or more categories. Returns previous state for each category.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: setCategoryTargetsSchema,
    },
    async (input) => {
      try {
        const budgetId = await context.ynabClient.resolveRealBudgetId(
          input.budget_id,
        );
        const pendingId = await context.undoEngine.markPending(
          budgetId,
          `Updating ${input.targets.length} category target${input.targets.length === 1 ? "" : "s"}`,
        );
        try {
          // Fetch current state for all categories in parallel
          const prefetchResults = await Promise.all(
            input.targets.map(async (target) => ({
              target,
              before: await context.ynabClient.getCategoryById(
                budgetId,
                target.category_id,
              ),
            })),
          );

          const updateResults = await Promise.all(
            prefetchResults.map(async ({ target, before }) => {
              try {
                if (!before) {
                  return {
                    result: {
                      category_id: target.category_id,
                      status: "error",
                      message: "Category not found.",
                    } as Record<string, unknown>,
                    undoEntry: null,
                  };
                }

                const updates: {
                  goal_target?: number | null;
                  goal_target_date?: string | null;
                } = {};

                if (target.goal_target !== undefined) {
                  updates.goal_target =
                    target.goal_target !== null
                      ? currencyToMilliunits(asCurrency(target.goal_target))
                      : null;
                }

                if (target.goal_target_date !== undefined) {
                  updates.goal_target_date = target.goal_target_date;
                }

                const updated = await context.ynabClient.updateCategory(
                  budgetId,
                  target.category_id,
                  updates,
                );

                const beforeTarget =
                  before.goal_target !== null &&
                  before.goal_target !== undefined
                    ? milliunitsToCurrency(asMilliunits(before.goal_target))
                    : null;
                const afterTarget =
                  updated.goal_target !== null &&
                  updated.goal_target !== undefined
                    ? milliunitsToCurrency(asMilliunits(updated.goal_target))
                    : null;

                return {
                  result: {
                    category_id: target.category_id,
                    category_name: updated.name,
                    status: "updated",
                    before: {
                      goal_type: before.goal_type ?? null,
                      goal_target: beforeTarget,
                      goal_target_date: before.goal_target_date ?? null,
                    },
                    after: {
                      goal_type: updated.goal_type ?? null,
                      goal_target: afterTarget,
                      goal_target_date: updated.goal_target_date ?? null,
                    },
                  } as Record<string, unknown>,
                  undoEntry: {
                    operation: "set_category_target" as const,
                    description: `Set target for category ${updated.name ?? target.category_id}.`,
                    undo_action: {
                      type: "update" as const,
                      entity_type: "category_target" as const,
                      entity_id: target.category_id,
                      expected_state: {
                        category_id: target.category_id,
                        goal_target: updated.goal_target ?? null,
                        goal_target_date: updated.goal_target_date ?? null,
                      },
                      restore_state: {
                        category_id: target.category_id,
                        goal_target: before.goal_target ?? null,
                        goal_target_date: before.goal_target_date ?? null,
                      },
                    },
                  },
                };
              } catch (error) {
                return {
                  result: {
                    category_id: target.category_id,
                    status: "error",
                    message: extractErrorMessage(error, "Update failed."),
                  } as Record<string, unknown>,
                  undoEntry: null,
                };
              }
            }),
          );

          const results = updateResults.map((r) => r.result);
          const undoEntries = updateResults
            .map((r) => r.undoEntry)
            .filter((e): e is NonNullable<typeof e> => e !== null);

          const undoHistoryIds = await recordUndoAndGetIds(
            context.undoEngine,
            budgetId,
            undoEntries,
          );

          return jsonToolResult({
            budget_id: budgetId,
            results,
            undo_history_ids: undoHistoryIds,
          });
        } finally {
          await context.undoEngine.clearPending(budgetId, pendingId);
        }
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to set category targets."),
        );
      }
    },
  );
}
