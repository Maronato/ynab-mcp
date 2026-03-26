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
  amount_min: z.number().optional(),
  amount_max: z.number().optional(),
  memo_contains: z.string().optional(),
  type: z.enum(["uncategorized", "unapproved"]).optional(),
  cleared: z.boolean().optional(),
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

const createTransactionItemSchema = z.object({
  account_id: z.string(),
  date: z.string(),
  amount: z.number(),
  payee_name: z.string().nullable().optional(),
  payee_id: z.string().nullable().optional(),
  category_id: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
  cleared: z.enum(clearedStatuses).optional(),
  approved: z.boolean().optional(),
  flag_color: z.union([z.enum(transactionFlagColors), z.null()]).optional(),
});

const createTransactionsSchema = z.object({
  budget_id: z.string().optional(),
  transactions: z.array(createTransactionItemSchema).min(1),
});

const updateTransactionItemSchema = z.object({
  transaction_id: z.string(),
  account_id: z.string().optional(),
  date: z.string().optional(),
  amount: z.number().optional(),
  payee_name: z.string().nullable().optional(),
  payee_id: z.string().nullable().optional(),
  category_id: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
  cleared: z.enum(clearedStatuses).optional(),
  approved: z.boolean().optional(),
  flag_color: z.union([z.enum(transactionFlagColors), z.null()]).optional(),
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

        const deleteResults = await Promise.all(
          prefetchResults.map(
            async ({ id: transactionId, transaction: before }) => {
              if (!before) {
                return {
                  result: {
                    transaction_id: transactionId,
                    status: "error",
                    message: "Transaction not found.",
                  } as Record<string, unknown>,
                  undoEntry: null,
                };
              }

              const deleted = await context.ynabClient.deleteTransaction(
                resolvedBudgetId,
                transactionId,
              );

              if (!deleted) {
                return {
                  result: {
                    transaction_id: transactionId,
                    status: "error",
                    message: "Delete request failed.",
                  } as Record<string, unknown>,
                  undoEntry: null,
                };
              }

              return {
                result: {
                  transaction_id: transactionId,
                  status: "deleted",
                } as Record<string, unknown>,
                undoEntry: {
                  operation: "delete_transaction" as const,
                  description: `Deleted transaction ${transactionId}.`,
                  undo_action: {
                    type: "create" as const,
                    entity_type: "transaction" as const,
                    entity_id: transactionId,
                    expected_state: {},
                    restore_state: snapshotTransaction(before),
                  },
                },
              };
            },
          ),
        );

        const results = deleteResults.map((r) => r.result);
        if (deleteResults.some((r) => r.undoEntry !== null)) {
          context.payeeProfileAnalyzer.invalidate(resolvedBudgetId);
        }
        const undoEntries = deleteResults
          .map((r) => r.undoEntry)
          .filter((e): e is NonNullable<typeof e> => e !== null);

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
