import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { recordUndoAndGetIds } from "../shared/undo-helpers.js";
import { extractErrorMessage } from "../ynab/errors.js";
import {
  asMilliunits,
  formatCurrency,
  formatScheduledTransactionForOutput,
  snapshotScheduledTransaction,
} from "../ynab/format.js";
import type {
  CreateScheduledTransactionInput,
  UpdateScheduledTransactionInput,
} from "../ynab/types.js";

// The YNAB API only accepts these five frequency values.
// The SDK enum includes compound values (everyOtherWeek, twiceAMonth, etc.)
// but the API rejects them on both create and update. Scheduled transactions
// with compound frequencies can only be created through the YNAB app.
const frequencies = ["never", "daily", "weekly", "monthly", "yearly"] as const;

const flagColors = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
] as const;

const getScheduledTransactionsSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe("Budget ID. Omit to use the last-used budget."),
  account_id: z.string().optional(),
  category_id: z.string().optional(),
  due_after: z
    .string()
    .optional()
    .describe(
      "Only include transactions with next due date on or after this date (YYYY-MM-DD).",
    ),
  due_before: z
    .string()
    .optional()
    .describe(
      "Only include transactions with next due date on or before this date (YYYY-MM-DD).",
    ),
});

const createScheduledTransactionsSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe("Budget ID. Omit to use the last-used budget."),
  transactions: z
    .array(
      z.object({
        account_id: z.string(),
        date: z.string().describe("Date in YYYY-MM-DD format."),
        amount: z
          .number()
          .describe(
            "Amount in currency units (e.g., -5.55 for negative five dollars and fifty-five cents). Do NOT use milliunits.",
          ),
        payee_name: z.string().nullable().optional(),
        payee_id: z.string().nullable().optional(),
        category_id: z.string().nullable().optional(),
        memo: z.string().nullable().optional(),
        frequency: z.enum(frequencies),
        flag_color: z.union([z.enum(flagColors), z.null()]).optional(),
      }),
    )
    .min(1)
    .max(50),
});

const updateScheduledTransactionsSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe("Budget ID. Omit to use the last-used budget."),
  transactions: z
    .array(
      z.object({
        scheduled_transaction_id: z.string(),
        account_id: z.string().optional(),
        date: z.string().optional().describe("Date in YYYY-MM-DD format."),
        amount: z
          .number()
          .optional()
          .describe(
            "Amount in currency units (e.g., -5.55 for negative five dollars and fifty-five cents). Do NOT use milliunits.",
          ),
        payee_name: z.string().nullable().optional(),
        payee_id: z.string().nullable().optional(),
        category_id: z.string().nullable().optional(),
        memo: z.string().nullable().optional(),
        frequency: z.enum(frequencies).optional(),
        flag_color: z.union([z.enum(flagColors), z.null()]).optional(),
      }),
    )
    .min(1)
    .max(50),
});

const deleteScheduledTransactionsSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe("Budget ID. Omit to use the last-used budget."),
  scheduled_transaction_ids: z.array(z.string()).min(1).max(50),
});

export function registerScheduledTransactionTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "get_scheduled_transactions",
    {
      title: "Get Scheduled Transactions",
      description:
        "Get scheduled transactions with optional account/category filtering.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: getScheduledTransactionsSchema,
    },
    async (input) => {
      try {
        const [transactions, lookups, settings] = await Promise.all([
          context.ynabClient.getScheduledTransactions(input.budget_id, {
            accountId: input.account_id,
            categoryId: input.category_id,
            dueAfter: input.due_after,
            dueBefore: input.due_before,
          }),
          context.ynabClient.getNameLookup(input.budget_id),
          context.ynabClient.getBudgetSettings(input.budget_id),
        ]);

        return jsonToolResult({
          budget_id: context.ynabClient.resolveBudgetId(input.budget_id),
          count: transactions.length,
          transactions: transactions.map((transaction) =>
            formatScheduledTransactionForOutput(
              { ...transaction, amount: asMilliunits(transaction.amount) },
              lookups,
              settings.currency_format,
            ),
          ),
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to get scheduled transactions."),
        );
      }
    },
  );

  server.registerTool(
    "create_scheduled_transactions",
    {
      title: "Create Scheduled Transactions",
      description:
        "Create one or more scheduled transactions. Each successful creation is undoable.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: createScheduledTransactionsSchema,
    },
    async ({ budget_id: budgetId, transactions }) => {
      try {
        const resolvedBudgetId =
          await context.ynabClient.resolveRealBudgetId(budgetId);
        const [lookups, settings] = await Promise.all([
          context.ynabClient.getNameLookup(resolvedBudgetId),
          context.ynabClient.getBudgetSettings(resolvedBudgetId),
        ]);
        const createdTransactions: Array<Record<string, unknown>> = [];
        const results: Array<Record<string, unknown>> = [];
        const undoEntries: Array<{
          operation: "create_scheduled_transaction";
          description: string;
          undo_action: {
            type: "delete";
            entity_type: "scheduled_transaction";
            entity_id: string;
            expected_state: Record<string, unknown>;
            restore_state: Record<string, unknown>;
          };
        }> = [];

        for (const [inputIndex, transaction] of transactions.entries()) {
          try {
            const created = await context.ynabClient.createScheduledTransaction(
              resolvedBudgetId,
              transaction as CreateScheduledTransactionInput,
            );
            if (
              created.payee_id &&
              !lookups.payeeById.has(created.payee_id) &&
              transaction.payee_name
            ) {
              lookups.payeeById.set(created.payee_id, transaction.payee_name);
            }
            const formatted = formatScheduledTransactionForOutput(
              { ...created, amount: asMilliunits(created.amount) },
              lookups,
              settings.currency_format,
            );

            createdTransactions.push(formatted);
            results.push({
              input_index: inputIndex,
              status: "created",
              transaction: formatted,
            });
            undoEntries.push({
              operation: "create_scheduled_transaction",
              description: `Created scheduled transaction ${created.id} (${formatCurrency(asMilliunits(created.amount), settings.currency_format)}).`,
              undo_action: {
                type: "delete",
                entity_type: "scheduled_transaction",
                entity_id: created.id,
                expected_state: snapshotScheduledTransaction(created),
                restore_state: {},
              },
            });
          } catch (error) {
            results.push({
              input_index: inputIndex,
              status: "error",
              message: extractErrorMessage(
                error,
                "Failed to create scheduled transaction.",
              ),
            });
          }
        }

        const undoHistoryIds = await recordUndoAndGetIds(
          context.undoEngine,
          resolvedBudgetId,
          undoEntries,
        );

        return jsonToolResult({
          budget_id: resolvedBudgetId,
          created_count: createdTransactions.length,
          results,
          transactions: createdTransactions,
          undo_history_ids: undoHistoryIds,
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(
            error,
            "Failed to create scheduled transactions.",
          ),
        );
      }
    },
  );

  server.registerTool(
    "update_scheduled_transactions",
    {
      title: "Update Scheduled Transactions",
      description:
        "Update one or more scheduled transactions. Each successful update is undoable.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: updateScheduledTransactionsSchema,
    },
    async ({ budget_id: budgetId, transactions }) => {
      try {
        const resolvedBudgetId =
          await context.ynabClient.resolveRealBudgetId(budgetId);
        const [lookups, settings] = await Promise.all([
          context.ynabClient.getNameLookup(resolvedBudgetId),
          context.ynabClient.getBudgetSettings(resolvedBudgetId),
        ]);
        const results: Array<Record<string, unknown>> = [];
        const undoEntries: Array<{
          operation: "update_scheduled_transaction";
          description: string;
          undo_action: {
            type: "update";
            entity_type: "scheduled_transaction";
            entity_id: string;
            expected_state: Record<string, unknown>;
            restore_state: Record<string, unknown>;
          };
        }> = [];

        const prefetchResults = await Promise.all(
          transactions.map(async (transaction) => ({
            input: transaction,
            before: await context.ynabClient.getScheduledTransactionById(
              resolvedBudgetId,
              transaction.scheduled_transaction_id,
            ),
          })),
        );

        for (const { input: transaction, before } of prefetchResults) {
          if (!before) {
            results.push({
              scheduled_transaction_id: transaction.scheduled_transaction_id,
              status: "error",
              message: "Scheduled transaction not found.",
            });
            continue;
          }

          try {
            const updated = await context.ynabClient.updateScheduledTransaction(
              resolvedBudgetId,
              transaction as UpdateScheduledTransactionInput,
              before,
            );

            results.push({
              scheduled_transaction_id: transaction.scheduled_transaction_id,
              status: "updated",
              transaction: formatScheduledTransactionForOutput(
                { ...updated, amount: asMilliunits(updated.amount) },
                lookups,
                settings.currency_format,
              ),
            });

            undoEntries.push({
              operation: "update_scheduled_transaction",
              description: `Updated scheduled transaction ${transaction.scheduled_transaction_id}.`,
              undo_action: {
                type: "update",
                entity_type: "scheduled_transaction",
                entity_id: transaction.scheduled_transaction_id,
                expected_state: snapshotScheduledTransaction(updated),
                restore_state: snapshotScheduledTransaction(before),
              },
            });
          } catch (error) {
            results.push({
              scheduled_transaction_id: transaction.scheduled_transaction_id,
              status: "error",
              message: extractErrorMessage(
                error,
                "Failed to update scheduled transaction.",
              ),
            });
          }
        }

        const undoHistoryIds = await recordUndoAndGetIds(
          context.undoEngine,
          resolvedBudgetId,
          undoEntries,
        );

        return jsonToolResult({
          budget_id: resolvedBudgetId,
          results,
          undo_history_ids: undoHistoryIds,
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(
            error,
            "Failed to update scheduled transactions.",
          ),
        );
      }
    },
  );

  server.registerTool(
    "delete_scheduled_transactions",
    {
      title: "Delete Scheduled Transactions",
      description:
        "Delete one or more scheduled transactions. Each deletion is undoable.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: deleteScheduledTransactionsSchema,
    },
    async ({
      budget_id: budgetId,
      scheduled_transaction_ids: scheduledIds,
    }) => {
      try {
        const resolvedBudgetId =
          await context.ynabClient.resolveRealBudgetId(budgetId);
        const results: Array<Record<string, unknown>> = [];
        const undoEntries: Array<{
          operation: "delete_scheduled_transaction";
          description: string;
          undo_action: {
            type: "create";
            entity_type: "scheduled_transaction";
            entity_id: string;
            expected_state: Record<string, unknown>;
            restore_state: Record<string, unknown>;
          };
        }> = [];

        const prefetchResults = await Promise.all(
          scheduledIds.map(async (id) => ({
            id,
            before: await context.ynabClient.getScheduledTransactionById(
              resolvedBudgetId,
              id,
            ),
          })),
        );

        for (const { id: scheduledTransactionId, before } of prefetchResults) {
          if (!before) {
            results.push({
              scheduled_transaction_id: scheduledTransactionId,
              status: "error",
              message: "Scheduled transaction not found.",
            });
            continue;
          }

          try {
            const deleted = await context.ynabClient.deleteScheduledTransaction(
              resolvedBudgetId,
              scheduledTransactionId,
            );

            if (!deleted) {
              results.push({
                scheduled_transaction_id: scheduledTransactionId,
                status: "error",
                message: "Delete request failed.",
              });
              continue;
            }

            results.push({
              scheduled_transaction_id: scheduledTransactionId,
              status: "deleted",
            });

            undoEntries.push({
              operation: "delete_scheduled_transaction",
              description: `Deleted scheduled transaction ${scheduledTransactionId}.`,
              undo_action: {
                type: "create",
                entity_type: "scheduled_transaction",
                entity_id: scheduledTransactionId,
                expected_state: {},
                restore_state: snapshotScheduledTransaction(before),
              },
            });
          } catch (error) {
            results.push({
              scheduled_transaction_id: scheduledTransactionId,
              status: "error",
              message: extractErrorMessage(
                error,
                "Failed to delete scheduled transaction.",
              ),
            });
          }
        }

        const undoHistoryIds = await recordUndoAndGetIds(
          context.undoEngine,
          resolvedBudgetId,
          undoEntries,
        );

        return jsonToolResult({
          budget_id: resolvedBudgetId,
          results,
          undo_history_ids: undoHistoryIds,
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(
            error,
            "Failed to delete scheduled transactions.",
          ),
        );
      }
    },
  );
}
