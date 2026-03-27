import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import {
  formatCurrency,
  formatTransactionForOutput,
  snapshotTransaction,
} from "../ynab/format.js";
import type {
  CreateTransactionInput,
  TransactionSearchQuery,
  UpdateTransactionInput,
} from "../ynab/types.js";

const searchQuerySchema = z.object({
  since_date: z.string().optional(),
  until_date: z.string().optional(),
  account_id: z.string().optional(),
  category_id: z.string().optional(),
  payee_id: z.string().optional(),
  amount_min: z
    .number()
    .optional()
    .describe("Minimum amount in currency units (e.g., -10.00)."),
  amount_max: z
    .number()
    .optional()
    .describe("Maximum amount in currency units (e.g., 50.00)."),
  memo_contains: z
    .string()
    .optional()
    .describe("Case-insensitive substring match on memo."),
  payee_name_contains: z
    .string()
    .optional()
    .describe(
      "Case-insensitive substring match on payee name (e.g., 'uber'). No need to resolve payee IDs first.",
    ),
  category_name_contains: z
    .string()
    .optional()
    .describe("Case-insensitive substring match on category name."),
  flag_color: z
    .enum(["red", "orange", "yellow", "green", "blue", "purple"])
    .optional()
    .describe("Filter by flag color."),
  exclude_transfers: z
    .boolean()
    .optional()
    .describe("Exclude internal account transfers from results."),
  type: z.enum(["uncategorized", "unapproved"]).optional(),
  cleared: z
    .enum(["cleared", "uncleared", "reconciled"])
    .optional()
    .describe(
      "Filter by cleared status. 'cleared' = confirmed by bank, 'uncleared' = pending, 'reconciled' = verified and locked.",
    ),
  approved: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  sort: z.enum(["date_asc", "date_desc"]).optional(),
});

const searchTransactionsSchema = z.object({
  budget_id: z.string().optional(),
  queries: z.array(searchQuerySchema).min(1),
});

const transactionFlagColors = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
] as const;

const clearedStatuses = ["cleared", "uncleared", "reconciled"] as const;

const subtransactionSchema = z.object({
  amount: z
    .number()
    .describe(
      "Amount in currency units (e.g., -5.55 for negative five dollars and fifty-five cents). Do NOT use milliunits.",
    ),
  payee_id: z.string().nullable().optional(),
  payee_name: z.string().nullable().optional(),
  category_id: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
});

const createTransactionItemSchema = z.object({
  account_id: z.string(),
  date: z.string(),
  amount: z
    .number()
    .describe(
      "Amount in currency units (e.g., -5.55 for negative five dollars and fifty-five cents). Do NOT use milliunits.",
    ),
  payee_name: z.string().nullable().optional(),
  payee_id: z.string().nullable().optional(),
  category_id: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
  cleared: z.enum(clearedStatuses).optional(),
  approved: z.boolean().optional(),
  flag_color: z.union([z.enum(transactionFlagColors), z.null()]).optional(),
  subtransactions: z
    .array(subtransactionSchema)
    .optional()
    .describe(
      "Split this transaction across multiple categories. Subtransaction amounts must sum to the parent amount. " +
        "When subtransactions are provided, the parent category_id is typically omitted.",
    ),
});

const createTransactionsSchema = z.object({
  budget_id: z.string().optional(),
  transactions: z.array(createTransactionItemSchema).min(1),
});

const updateTransactionItemSchema = z.object({
  transaction_id: z.string(),
  account_id: z.string().optional(),
  date: z.string().optional(),
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
  cleared: z.enum(clearedStatuses).optional(),
  approved: z.boolean().optional(),
  flag_color: z.union([z.enum(transactionFlagColors), z.null()]).optional(),
  subtransactions: z
    .array(subtransactionSchema)
    .optional()
    .describe(
      "Replace existing subtransactions with these splits. Amounts must sum to the parent amount.",
    ),
});

const updateTransactionsSchema = z.object({
  budget_id: z.string().optional(),
  transactions: z.array(updateTransactionItemSchema).min(1),
});

const deleteTransactionsSchema = z.object({
  budget_id: z.string().optional(),
  transaction_ids: z.array(z.string()).min(1),
});

export function registerTransactionTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "search_transactions",
    {
      title: "Search Transactions",
      description:
        "Run one or more transaction searches in a single call with rich filters and sorted results.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: searchTransactionsSchema,
    },
    async ({ budget_id: budgetId, queries }) => {
      try {
        const [lookups, settings] = await Promise.all([
          context.ynabClient.getNameLookup(budgetId),
          context.ynabClient.getBudgetSettings(budgetId),
        ]);

        const resultSets = await Promise.all(
          queries.map(async (query, index) => {
            const transactions = await context.ynabClient.searchTransactions(
              budgetId,
              query as TransactionSearchQuery,
            );

            return {
              query_index: index,
              query,
              count: transactions.length,
              transactions: transactions.map((transaction) =>
                formatTransactionForOutput(
                  transaction,
                  lookups,
                  settings.currency_format,
                ),
              ),
            };
          }),
        );

        return jsonToolResult({
          budget_id: context.ynabClient.resolveBudgetId(budgetId),
          result_sets: resultSets,
        });
      } catch (error) {
        return errorToolResult(
          error instanceof Error
            ? error.message
            : "Failed to search transactions.",
        );
      }
    },
  );

  server.registerTool(
    "create_transactions",
    {
      title: "Create Transactions",
      description:
        "Create one or more transactions in a single call. Each successful creation is undoable.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: createTransactionsSchema,
    },
    async ({ budget_id: budgetId, transactions }) => {
      try {
        const resolvedBudgetId =
          await context.ynabClient.resolveRealBudgetId(budgetId);
        const created = await context.ynabClient.createTransactions(
          resolvedBudgetId,
          transactions as CreateTransactionInput[],
        );
        context.payeeProfileAnalyzer.invalidate(resolvedBudgetId);
        const [lookups, settings] = await Promise.all([
          context.ynabClient.getNameLookup(resolvedBudgetId),
          context.ynabClient.getBudgetSettings(resolvedBudgetId),
        ]);

        for (let i = 0; i < created.length; i++) {
          const payeeId = created[i].payee_id;
          if (payeeId && !lookups.payeeById.has(payeeId)) {
            const inputPayeeName = transactions[i]?.payee_name;
            if (inputPayeeName) {
              lookups.payeeById.set(payeeId, inputPayeeName);
            }
          }
        }

        const formatted = created.map((transaction) =>
          formatTransactionForOutput(
            transaction,
            lookups,
            settings.currency_format,
          ),
        );

        const undoEntries = created.map((transaction) => ({
          operation: "create_transaction" as const,
          description: `Created transaction ${transaction.id} (${formatCurrency(transaction.amount, settings.currency_format)}).`,
          undo_action: {
            type: "delete" as const,
            entity_type: "transaction" as const,
            entity_id: transaction.id,
            expected_state: snapshotTransaction(transaction),
            restore_state: {},
          },
        }));

        const undoHistoryIds =
          undoEntries.length > 0
            ? (
                await context.undoEngine.recordEntries(
                  resolvedBudgetId,
                  undoEntries,
                )
              ).map((entry) => entry.id)
            : [];

        return jsonToolResult({
          budget_id: resolvedBudgetId,
          created_count: created.length,
          transactions: formatted,
          undo_history_ids: undoHistoryIds,
        });
      } catch (error) {
        return errorToolResult(
          error instanceof Error
            ? error.message
            : "Failed to create transactions.",
        );
      }
    },
  );

  server.registerTool(
    "update_transactions",
    {
      title: "Update Transactions",
      description:
        "Update one or more existing transactions in a single call. Each successful update is undoable.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: updateTransactionsSchema,
    },
    async ({ budget_id: budgetId, transactions }) => {
      try {
        const resolvedBudgetId =
          await context.ynabClient.resolveRealBudgetId(budgetId);
        const beforeById = new Map<
          string,
          ReturnType<typeof snapshotTransaction>
        >();
        const missingIds = new Set<string>();

        const prefetchResults = await Promise.all(
          transactions.map(async (update) => ({
            id: update.transaction_id,
            transaction: await context.ynabClient.getTransactionById(
              resolvedBudgetId,
              update.transaction_id,
            ),
          })),
        );

        for (const result of prefetchResults) {
          if (!result.transaction) {
            missingIds.add(result.id);
          } else {
            beforeById.set(result.id, snapshotTransaction(result.transaction));
          }
        }

        const updatesToApply = transactions.filter(
          (update) => !missingIds.has(update.transaction_id),
        );

        const updated = updatesToApply.length
          ? await context.ynabClient.updateTransactions(
              resolvedBudgetId,
              updatesToApply as UpdateTransactionInput[],
            )
          : [];
        if (updated.length > 0) {
          context.payeeProfileAnalyzer.invalidate(resolvedBudgetId);
        }

        const [lookups, settings] = await Promise.all([
          context.ynabClient.getNameLookup(resolvedBudgetId),
          context.ynabClient.getBudgetSettings(resolvedBudgetId),
        ]);

        const afterById = new Map(
          updated.map((transaction) => [transaction.id, transaction]),
        );
        const undoEntries: Array<{
          operation: "update_transaction";
          description: string;
          undo_action: {
            type: "update";
            entity_type: "transaction";
            entity_id: string;
            expected_state: Record<string, unknown>;
            restore_state: Record<string, unknown>;
          };
        }> = [];

        const results: Array<Record<string, unknown>> = [];

        for (const update of updatesToApply) {
          const after = afterById.get(update.transaction_id);
          const before = beforeById.get(update.transaction_id);

          if (!after || !before) {
            results.push({
              transaction_id: update.transaction_id,
              status: "error",
              message: "Transaction update did not return a result.",
            });
            continue;
          }

          results.push({
            transaction_id: update.transaction_id,
            status: "updated",
            transaction: formatTransactionForOutput(
              after,
              lookups,
              settings.currency_format,
            ),
          });

          undoEntries.push({
            operation: "update_transaction",
            description: `Updated transaction ${update.transaction_id}.`,
            undo_action: {
              type: "update",
              entity_type: "transaction",
              entity_id: update.transaction_id,
              expected_state: snapshotTransaction(after),
              restore_state: before,
            },
          });
        }

        for (const missingId of missingIds.values()) {
          results.push({
            transaction_id: missingId,
            status: "error",
            message: "Transaction not found.",
          });
        }

        const undoHistoryIds =
          undoEntries.length > 0
            ? (
                await context.undoEngine.recordEntries(
                  resolvedBudgetId,
                  undoEntries,
                )
              ).map((entry) => entry.id)
            : [];

        return jsonToolResult({
          budget_id: resolvedBudgetId,
          results,
          undo_history_ids: undoHistoryIds,
        });
      } catch (error) {
        return errorToolResult(
          error instanceof Error
            ? error.message
            : "Failed to update transactions.",
        );
      }
    },
  );

  server.registerTool(
    "delete_transactions",
    {
      title: "Delete Transactions",
      description:
        "Delete one or more transactions. Each deletion is undoable by re-creating the transaction.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: deleteTransactionsSchema,
    },
    async ({ budget_id: budgetId, transaction_ids: transactionIds }) => {
      try {
        const resolvedBudgetId =
          await context.ynabClient.resolveRealBudgetId(budgetId);

        const prefetchResults = await Promise.all(
          transactionIds.map(async (id) => ({
            id,
            transaction: await context.ynabClient.getTransactionById(
              resolvedBudgetId,
              id,
            ),
          })),
        );

        const results: Array<Record<string, unknown>> = [];
        const undoEntries: Array<{
          operation: "delete_transaction";
          description: string;
          undo_action: {
            type: "create";
            entity_type: "transaction";
            entity_id: string;
            expected_state: Record<string, unknown>;
            restore_state: Record<string, unknown>;
          };
        }> = [];

        for (const {
          id: transactionId,
          transaction: before,
        } of prefetchResults) {
          if (!before) {
            results.push({
              transaction_id: transactionId,
              status: "error",
              message: "Transaction not found.",
            });
            continue;
          }

          try {
            const deleted = await context.ynabClient.deleteTransaction(
              resolvedBudgetId,
              transactionId,
            );

            if (!deleted) {
              results.push({
                transaction_id: transactionId,
                status: "error",
                message: "Delete request failed.",
              });
              continue;
            }

            results.push({
              transaction_id: transactionId,
              status: "deleted",
            });
            undoEntries.push({
              operation: "delete_transaction",
              description: `Deleted transaction ${transactionId}.`,
              undo_action: {
                type: "create",
                entity_type: "transaction",
                entity_id: transactionId,
                expected_state: {},
                restore_state: snapshotTransaction(before),
              },
            });
          } catch (error) {
            results.push({
              transaction_id: transactionId,
              status: "error",
              message: getErrorMessage(error, "Failed to delete transaction."),
            });
          }
        }

        if (undoEntries.length > 0) {
          context.payeeProfileAnalyzer.invalidate(resolvedBudgetId);
        }

        const undoHistoryIds =
          undoEntries.length > 0
            ? (
                await context.undoEngine.recordEntries(
                  resolvedBudgetId,
                  undoEntries,
                )
              ).map((entry) => entry.id)
            : [];

        return jsonToolResult({
          budget_id: resolvedBudgetId,
          results,
          undo_history_ids: undoHistoryIds,
        });
      } catch (error) {
        return errorToolResult(
          error instanceof Error
            ? error.message
            : "Failed to delete transactions.",
        );
      }
    },
  );
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
