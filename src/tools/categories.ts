import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { formatCurrency, milliunitsToCurrency } from "../ynab/format.js";

const getCategoriesSchema = z.object({
  budget_id: z.string().optional(),
  month: z.string().optional(),
  group_id: z.string().optional(),
  include_hidden: z.boolean().optional(),
});

const getMonthlyBudgetSchema = z.object({
  budget_id: z.string().optional(),
  month: z.string().optional(),
});

const setCategoryBudgetsSchema = z.object({
  budget_id: z.string().optional(),
  assignments: z
    .array(
      z.object({
        category_id: z.string(),
        month: z.string(),
        budgeted: z
          .number()
          .describe(
            "Budgeted amount in currency units (e.g., 150.00 for one hundred fifty dollars). Do NOT use milliunits.",
          ),
      }),
    )
    .min(1),
});

export function registerCategoryTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "get_categories",
    {
      title: "Get Categories",
      description:
        "Get categories with goal progress details (goal type, target, target date, percentage complete). " +
        "Use this when you need goal information. Use get_monthly_budget instead for a quick budget overview with overspending flags.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: getCategoriesSchema,
    },
    async (input) => {
      try {
        const [groups, settings] = await Promise.all([
          context.ynabClient.getCategories(input.budget_id, {
            month: input.month,
            groupId: input.group_id,
            includeHidden: input.include_hidden,
          }),
          context.ynabClient.getBudgetSettings(input.budget_id),
        ]);

        return jsonToolResult({
          month: input.month ?? "current",
          groups: groups.map((group) => ({
            id: group.id,
            name: group.name,
            hidden: group.hidden,
            categories: group.categories.map((category) => ({
              id: category.id,
              name: category.name,
              hidden: category.hidden,
              budgeted: milliunitsToCurrency(category.budgeted),
              budgeted_display: formatCurrency(
                category.budgeted,
                settings.currency_format,
              ),
              activity: milliunitsToCurrency(category.activity),
              activity_display: formatCurrency(
                category.activity,
                settings.currency_format,
              ),
              balance: milliunitsToCurrency(category.balance),
              balance_display: formatCurrency(
                category.balance,
                settings.currency_format,
              ),
              goal_type: category.goal_type ?? null,
              goal_target: category.goal_target
                ? milliunitsToCurrency(category.goal_target)
                : null,
              goal_target_display:
                category.goal_target !== null &&
                category.goal_target !== undefined
                  ? formatCurrency(
                      category.goal_target,
                      settings.currency_format,
                    )
                  : null,
              goal_target_date: category.goal_target_date ?? null,
              goal_percentage_complete:
                category.goal_percentage_complete ?? null,
            })),
          })),
        });
      } catch (error) {
        return errorToolResult(
          error instanceof Error ? error.message : "Failed to get categories.",
        );
      }
    },
  );

  server.registerTool(
    "get_monthly_budget",
    {
      title: "Get Monthly Budget",
      description:
        "Get a quick month overview with income/budgeted/activity totals and per-category balances with overspending flags. " +
        "Use this for budget summaries. Use get_categories instead when you need goal progress details.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: getMonthlyBudgetSchema,
    },
    async (input) => {
      try {
        const monthValue = input.month ?? "current";
        const [month, categoryTree, settings] = await Promise.all([
          context.ynabClient.getMonthSummary(input.budget_id, monthValue),
          context.ynabClient.getCategories(input.budget_id, {
            includeHidden: false,
          }),
          context.ynabClient.getBudgetSettings(input.budget_id),
        ]);

        const monthCategoriesById = new Map(
          month.categories.map((category) => [category.id, category]),
        );

        return jsonToolResult({
          month: month.month,
          income: milliunitsToCurrency(month.income),
          income_display: formatCurrency(
            month.income,
            settings.currency_format,
          ),
          budgeted: milliunitsToCurrency(month.budgeted),
          budgeted_display: formatCurrency(
            month.budgeted,
            settings.currency_format,
          ),
          activity: milliunitsToCurrency(month.activity),
          activity_display: formatCurrency(
            month.activity,
            settings.currency_format,
          ),
          to_be_budgeted: milliunitsToCurrency(month.to_be_budgeted),
          to_be_budgeted_display: formatCurrency(
            month.to_be_budgeted,
            settings.currency_format,
          ),
          age_of_money: month.age_of_money ?? null,
          groups: categoryTree.map((group) => ({
            id: group.id,
            name: group.name,
            categories: group.categories.map((treeCat) => {
              const category = monthCategoriesById.get(treeCat.id) ?? treeCat;
              return {
                id: category.id,
                name: category.name,
                budgeted: milliunitsToCurrency(category.budgeted),
                budgeted_display: formatCurrency(
                  category.budgeted,
                  settings.currency_format,
                ),
                activity: milliunitsToCurrency(category.activity),
                activity_display: formatCurrency(
                  category.activity,
                  settings.currency_format,
                ),
                balance: milliunitsToCurrency(category.balance),
                balance_display: formatCurrency(
                  category.balance,
                  settings.currency_format,
                ),
                overspent: category.balance < 0,
              };
            }),
          })),
        });
      } catch (error) {
        return errorToolResult(
          error instanceof Error
            ? error.message
            : "Failed to get monthly budget.",
        );
      }
    },
  );

  server.registerTool(
    "set_category_budgets",
    {
      title: "Set Category Budgets",
      description:
        "Set budgeted amounts for one or more categories/month pairs in a single request.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: setCategoryBudgetsSchema,
    },
    async (input) => {
      try {
        const budgetId = await context.ynabClient.resolveRealBudgetId(
          input.budget_id,
        );
        const prefetchResults = await Promise.all(
          input.assignments.map(async (assignment) => ({
            assignment,
            before: await context.ynabClient.getMonthCategoryById(
              budgetId,
              assignment.month,
              assignment.category_id,
            ),
          })),
        );

        const updateResults = await Promise.all(
          prefetchResults.map(async ({ assignment, before }) => {
            try {
              if (!before) {
                return {
                  result: {
                    assignment,
                    status: "error",
                    message: "Category/month not found.",
                  } as Record<string, unknown>,
                  undoEntry: null,
                };
              }

              const updated = await context.ynabClient.setCategoryBudget(
                budgetId,
                assignment,
              );

              return {
                result: {
                  category_id: updated.id,
                  month: assignment.month,
                  status: "updated",
                  previous_budgeted_milliunits: before.budgeted,
                  updated_budgeted_milliunits: updated.budgeted,
                  previous_budgeted: milliunitsToCurrency(before.budgeted),
                  updated_budgeted: milliunitsToCurrency(updated.budgeted),
                } as Record<string, unknown>,
                undoEntry: {
                  operation: "set_category_budget" as const,
                  description: `Set budget for category ${assignment.category_id} in ${assignment.month}.`,
                  undo_action: {
                    type: "update" as const,
                    entity_type: "category_budget" as const,
                    entity_id: `${assignment.month}:${assignment.category_id}`,
                    expected_state: {
                      category_id: updated.id,
                      month: assignment.month,
                      budgeted: updated.budgeted,
                    },
                    restore_state: {
                      category_id: before.id,
                      month: assignment.month,
                      budgeted: before.budgeted,
                    },
                  },
                },
              };
            } catch (error) {
              return {
                result: {
                  assignment,
                  status: "error",
                  message:
                    error instanceof Error ? error.message : "Update failed.",
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

        let undoHistoryIds: string[] = [];
        if (undoEntries.length > 0) {
          const created = await context.undoEngine.recordEntries(
            budgetId,
            undoEntries,
          );
          undoHistoryIds = created.map((entry) => entry.id);
        }

        return jsonToolResult({
          budget_id: budgetId,
          results,
          undo_history_ids: undoHistoryIds,
        });
      } catch (error) {
        return errorToolResult(
          error instanceof Error
            ? error.message
            : "Failed to set category budgets.",
        );
      }
    },
  );
}
