import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { recordUndoAndGetIds } from "../shared/undo-helpers.js";
import { extractErrorMessage } from "../ynab/errors.js";
import { formatCurrency, milliunitsToCurrency } from "../ynab/format.js";

const listCategoriesSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe("Budget ID. Omit to use the last-used budget."),
  group_id: z.string().optional(),
  include_hidden: z.boolean().optional(),
});

const getTargetsSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe("Budget ID. Omit to use the last-used budget."),
  month: z
    .string()
    .optional()
    .describe(
      "Month in YYYY-MM-DD format (use first day of month). Scopes target percentage_complete calculation. Defaults to current month.",
    ),
  group_id: z.string().optional(),
  include_hidden: z.boolean().optional(),
});

const getMonthlyBudgetSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe("Budget ID. Omit to use the last-used budget."),
  month: z
    .string()
    .optional()
    .describe(
      "Month in YYYY-MM-DD format (use first day of month). Defaults to current month.",
    ),
  include_hidden: z
    .boolean()
    .optional()
    .describe(
      "Include hidden categories in the monthly budget output. Defaults to false for a cleaner review surface.",
    ),
});

const setCategoryBudgetsSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe("Budget ID. Omit to use the last-used budget."),
  assignments: z
    .array(
      z.object({
        category_id: z.string(),
        month: z
          .string()
          .describe("Month in YYYY-MM-DD format (use first day of month)."),
        budgeted: z
          .number()
          .describe(
            "Budgeted amount in currency units (e.g., 150.00 for one hundred fifty dollars). Do NOT use milliunits.",
          ),
      }),
    )
    .min(1)
    .max(200),
});

export function registerCategoryTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "list_categories",
    {
      title: "List Categories",
      description:
        "Get all categories with their group hierarchy, IDs, and names. " +
        "No budget figures or target data — lightweight and fast. " +
        "Use this to resolve category names to IDs before write operations.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: listCategoriesSchema,
    },
    async (input) => {
      try {
        const groups = await context.ynabClient.getCategories(input.budget_id, {
          groupId: input.group_id,
          includeHidden: input.include_hidden,
        });

        return jsonToolResult({
          budget_id: context.ynabClient.resolveBudgetId(input.budget_id),
          groups: groups.map((group) => ({
            id: group.id,
            name: group.name,
            hidden: group.hidden,
            categories: group.categories.map((category) => ({
              id: category.id,
              name: category.name,
              category_group_id: group.id,
              category_group_name: group.name,
              hidden: category.hidden,
            })),
          })),
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to list categories."),
        );
      }
    },
  );

  server.registerTool(
    "get_targets",
    {
      title: "Get Category Targets",
      description:
        "Get categories with target progress details only: target type, amount, date, " +
        "underfunded amount, months remaining, and percentage complete. " +
        "Use this when you need target-specific guidance rather than monthly budget balances. " +
        "Categories without targets return null target fields rather than being omitted.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: getTargetsSchema,
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
              category_group_id: group.id,
              category_group_name: group.name,
              hidden: category.hidden,
              target_type: category.goal_type ?? null,
              target_needs_whole_amount:
                category.goal_needs_whole_amount ?? null,
              target_amount:
                category.goal_target !== null &&
                category.goal_target !== undefined
                  ? milliunitsToCurrency(category.goal_target)
                  : null,
              target_amount_display:
                category.goal_target !== null &&
                category.goal_target !== undefined
                  ? formatCurrency(
                      category.goal_target,
                      settings.currency_format,
                    )
                  : null,
              target_date: category.goal_target_date ?? null,
              target_months_to_budget: category.goal_months_to_budget ?? null,
              target_underfunded:
                category.goal_under_funded !== null &&
                category.goal_under_funded !== undefined
                  ? milliunitsToCurrency(category.goal_under_funded)
                  : null,
              target_underfunded_display:
                category.goal_under_funded !== null &&
                category.goal_under_funded !== undefined
                  ? formatCurrency(
                      category.goal_under_funded,
                      settings.currency_format,
                    )
                  : null,
              target_overall_funded:
                category.goal_overall_funded !== null &&
                category.goal_overall_funded !== undefined
                  ? milliunitsToCurrency(category.goal_overall_funded)
                  : null,
              target_overall_funded_display:
                category.goal_overall_funded !== null &&
                category.goal_overall_funded !== undefined
                  ? formatCurrency(
                      category.goal_overall_funded,
                      settings.currency_format,
                    )
                  : null,
              target_percentage_complete:
                category.goal_percentage_complete ?? null,
            })),
          })),
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to get targets."),
        );
      }
    },
  );

  server.registerTool(
    "get_monthly_budget",
    {
      title: "Get Monthly Budget",
      description:
        "Get a month overview with income/budgeted/activity totals and per-category budget figures " +
        "(budgeted, activity, balance) with overspending flags. Returns all visible categories by default — " +
        "set include_hidden=true to include hidden ones. Categories with no activity show zeroes. No target data.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
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
            includeHidden: input.include_hidden,
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
            hidden: group.hidden,
            categories: group.categories.map((treeCat) => {
              const monthCat = monthCategoriesById.get(treeCat.id);
              const budgeted = monthCat?.budgeted ?? 0;
              const activity = monthCat?.activity ?? 0;
              const balance = monthCat?.balance ?? 0;
              return {
                id: treeCat.id,
                name: treeCat.name,
                category_group_id: group.id,
                category_group_name: group.name,
                hidden: treeCat.hidden,
                budgeted: milliunitsToCurrency(budgeted),
                budgeted_display: formatCurrency(
                  budgeted,
                  settings.currency_format,
                ),
                activity: milliunitsToCurrency(activity),
                activity_display: formatCurrency(
                  activity,
                  settings.currency_format,
                ),
                balance: milliunitsToCurrency(balance),
                balance_display: formatCurrency(
                  balance,
                  settings.currency_format,
                ),
                overspent: balance < 0,
              };
            }),
          })),
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to get monthly budget."),
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
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to set category budgets."),
        );
      }
    },
  );
}
