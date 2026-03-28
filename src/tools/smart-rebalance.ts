import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { extractErrorMessage } from "../ynab/errors.js";
import {
  asCurrency,
  asMilliunits,
  currencyToMilliunits,
  formatCurrency,
  milliunitsToCurrency,
} from "../ynab/format.js";

const INTERNAL_GROUP_NAMES = new Set([
  "Internal Master Category",
  "Credit Card Payments",
]);

const coverOverspendingSchema = z.object({
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
});

function getCurrentMonth(): string {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

async function buildDeterministicRebalance(
  context: AppContext,
  budgetId: string,
  month: string,
  overspent: Array<{
    id: string;
    name: string;
    group_name: string;
    balance: number;
    budgeted: number;
    activity: number;
    target_type: string | null;
  }>,
  surplus: Array<{
    id: string;
    name: string;
    group_name: string;
    balance: number;
    budgeted: number;
    target_type: string | null;
    target_amount: number | null;
    target_percentage_complete: number | null;
  }>,
  settings: { currency_format: Parameters<typeof formatCurrency>[1] },
) {
  const resolvedMonth = month === "current" ? getCurrentMonth() : month;

  const sortedOverspent = [...overspent].sort((a, b) => a.balance - b.balance);
  const sortedSurplus = [...surplus].sort((a, b) => b.balance - a.balance);
  const remainingBalance = new Map(sortedSurplus.map((s) => [s.id, s.balance]));

  const suggestions: Array<{
    from_category_id: string;
    from_category_name: string;
    to_category_id: string;
    to_category_name: string;
    amount: number;
    amount_display: string;
    reasoning: string;
  }> = [];

  for (const category of sortedOverspent) {
    let deficit = Math.abs(category.balance);

    for (const source of sortedSurplus) {
      if (deficit <= 0) break;
      const available = remainingBalance.get(source.id) ?? 0;
      if (available <= 0) continue;

      const moveAmount = Math.min(deficit, available);
      remainingBalance.set(source.id, available - moveAmount);
      deficit -= moveAmount;

      suggestions.push({
        from_category_id: source.id,
        from_category_name: source.name,
        to_category_id: category.id,
        to_category_name: category.name,
        amount: moveAmount,
        amount_display: formatCurrency(
          currencyToMilliunits(asCurrency(moveAmount)),
          settings.currency_format,
        ),
        reasoning: `Cover ${category.name} deficit from largest available surplus.`,
      });
    }
  }

  const involvedCategoryIds = new Set<string>();
  for (const s of suggestions) {
    involvedCategoryIds.add(s.from_category_id);
    involvedCategoryIds.add(s.to_category_id);
  }

  const currentBudgets = await Promise.all(
    [...involvedCategoryIds].map(async (catId) => ({
      id: catId,
      category: await context.ynabClient.getMonthCategoryById(
        budgetId,
        resolvedMonth,
        catId,
      ),
    })),
  );

  const budgetAdjustments = new Map<
    string,
    { currentBudgeted: number; delta: number }
  >();

  for (const { id, category } of currentBudgets) {
    if (category) {
      budgetAdjustments.set(id, {
        currentBudgeted: category.budgeted,
        delta: 0,
      });
    }
  }

  for (const suggestion of suggestions) {
    const amountMilliunits = currencyToMilliunits(
      asCurrency(suggestion.amount),
    );
    const from = budgetAdjustments.get(suggestion.from_category_id);
    const to = budgetAdjustments.get(suggestion.to_category_id);
    if (from) from.delta -= amountMilliunits;
    if (to) to.delta += amountMilliunits;
  }

  const setBudgetActions = [...budgetAdjustments.entries()]
    .filter(([, adj]) => adj.delta !== 0)
    .map(([catId, adj]) => ({
      category_id: catId,
      month: resolvedMonth,
      budgeted: milliunitsToCurrency(
        asMilliunits(adj.currentBudgeted + adj.delta),
      ),
    }));

  return {
    budget_id: budgetId,
    month: resolvedMonth,
    suggestion_count: suggestions.length,
    suggestions,
    set_budget_actions: setBudgetActions,
  };
}

export function registerRebalanceTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "suggest_overspending_coverage",
    {
      title: "Suggest Overspending Coverage",
      description:
        "Analyze budget categories to identify overspending and suggest rebalancing moves. " +
        "Returns suggestions — does NOT apply changes. " +
        "Use the returned set_budget_actions with set_category_budgets to apply.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: coverOverspendingSchema,
    },
    async (input) => {
      try {
        const resolvedBudgetId = await context.ynabClient.resolveRealBudgetId(
          input.budget_id,
        );
        const month = input.month ?? getCurrentMonth();

        const [categoryGroups, settings] = await Promise.all([
          context.ynabClient.getCategories(resolvedBudgetId, { month }),
          context.ynabClient.getBudgetSettings(resolvedBudgetId),
        ]);

        const overspent: Array<{
          id: string;
          name: string;
          group_name: string;
          balance: number;
          balance_display: string;
          budgeted: number;
          activity: number;
          target_type: string | null;
        }> = [];

        const surplus: Array<{
          id: string;
          name: string;
          group_name: string;
          balance: number;
          balance_display: string;
          budgeted: number;
          target_type: string | null;
          target_amount: number | null;
          target_percentage_complete: number | null;
        }> = [];

        for (const group of categoryGroups) {
          if (INTERNAL_GROUP_NAMES.has(group.name)) continue;

          for (const cat of group.categories) {
            if (cat.hidden || cat.deleted) continue;

            if (cat.balance < 0) {
              overspent.push({
                id: cat.id,
                name: cat.name,
                group_name: group.name,
                balance: milliunitsToCurrency(asMilliunits(cat.balance)),
                balance_display: formatCurrency(
                  asMilliunits(cat.balance),
                  settings.currency_format,
                ),
                budgeted: milliunitsToCurrency(asMilliunits(cat.budgeted)),
                activity: milliunitsToCurrency(asMilliunits(cat.activity)),
                target_type: cat.goal_type ?? null,
              });
            } else if (cat.balance > 0) {
              surplus.push({
                id: cat.id,
                name: cat.name,
                group_name: group.name,
                balance: milliunitsToCurrency(asMilliunits(cat.balance)),
                balance_display: formatCurrency(
                  asMilliunits(cat.balance),
                  settings.currency_format,
                ),
                budgeted: milliunitsToCurrency(asMilliunits(cat.budgeted)),
                target_type: cat.goal_type ?? null,
                target_amount: cat.goal_target
                  ? milliunitsToCurrency(asMilliunits(cat.goal_target))
                  : null,
                target_percentage_complete:
                  cat.goal_percentage_complete ?? null,
              });
            }
          }
        }

        if (overspent.length === 0) {
          return jsonToolResult({
            budget_id: resolvedBudgetId,
            month,
            message: "No overspent categories found.",
            overspent_count: 0,
          });
        }

        const deterministicResult = await buildDeterministicRebalance(
          context,
          resolvedBudgetId,
          month,
          overspent,
          surplus,
          settings,
        );
        return jsonToolResult(deterministicResult);
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to analyze overspending."),
        );
      }
    },
  );
}
