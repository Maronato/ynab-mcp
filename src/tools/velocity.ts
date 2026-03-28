import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { extractErrorMessage } from "../ynab/errors.js";
import {
  type CurrencyFormatLike,
  formatCurrency,
  milliunitsToCurrency,
} from "../ynab/format.js";

const INTERNAL_GROUP_NAMES = new Set([
  "Internal Master Category",
  "Credit Card Payments",
]);

const spendingVelocitySchema = z.object({
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
  history_months: z
    .number()
    .int()
    .min(1)
    .max(12)
    .optional()
    .describe(
      "Number of prior months to use for historical average comparison. Defaults to 3.",
    ),
});

type RiskLevel = "likely_overspend" | "watch" | "safe";

interface CategoryVelocity {
  id: string;
  name: string;
  group_name: string;
  budgeted: number;
  budgeted_display: string;
  spent_so_far: number;
  spent_so_far_display: string;
  balance: number;
  balance_display: string;
  daily_burn_rate: number;
  daily_burn_rate_display: string;
  projected_total_spend: number;
  projected_total_spend_display: string;
  projected_remaining: number;
  projected_remaining_display: string;
  risk: RiskLevel;
  historical_monthly_avg: number | null;
  historical_monthly_avg_display: string | null;
}

export function registerVelocityTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "get_spending_velocity",
    {
      title: "Get Spending Velocity",
      description:
        "Mid-month spending pace analysis per category. Computes daily burn rates, " +
        "projects end-of-month totals, and flags categories likely to overspend " +
        "based on current trajectory and optional historical comparison.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: spendingVelocitySchema,
    },
    async (input) => {
      try {
        const month = input.month ?? getCurrentMonth();
        const historyMonths = input.history_months ?? 3;

        const [categoryGroups, settings] = await Promise.all([
          context.ynabClient.getCategories(input.budget_id, { month }),
          context.ynabClient.getBudgetSettings(input.budget_id),
        ]);

        const cf = settings.currency_format;

        // Date calculations
        const monthDate = new Date(month);
        const year = monthDate.getFullYear();
        const monthIndex = monthDate.getMonth();
        const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
        const today = new Date();

        // If analyzing current month, use today's day. Otherwise use full month.
        let dayOfMonth: number;
        if (today.getFullYear() === year && today.getMonth() === monthIndex) {
          dayOfMonth = today.getDate();
        } else if (today > monthDate) {
          // Past month - use full month
          dayOfMonth = daysInMonth;
        } else {
          // Future month - no spending data
          dayOfMonth = 0;
        }

        const daysRemaining = Math.max(0, daysInMonth - dayOfMonth);

        // Optionally fetch historical data for comparison
        let historicalByCategory: Map<string, number> | null = null;
        if (historyMonths > 0 && dayOfMonth > 0) {
          historicalByCategory = await computeHistoricalAverages(
            context,
            input.budget_id,
            month,
            historyMonths,
          );
        }

        // Analyze each category
        const categories: CategoryVelocity[] = [];
        const atRisk: Array<{
          id: string;
          name: string;
          risk: RiskLevel;
          projected_overspend: number;
          projected_overspend_display: string;
        }> = [];

        for (const group of categoryGroups) {
          if (INTERNAL_GROUP_NAMES.has(group.name)) continue;

          for (const cat of group.categories) {
            if (cat.hidden || cat.deleted) continue;
            if (cat.budgeted <= 0) continue;

            const spentSoFar = Math.abs(cat.activity);
            const dailyBurnRate = dayOfMonth > 0 ? spentSoFar / dayOfMonth : 0;
            const projectedTotalSpend = dailyBurnRate * daysInMonth;
            const projectedRemaining = cat.budgeted - projectedTotalSpend;

            let risk: RiskLevel;
            if (projectedTotalSpend > cat.budgeted * 1.1) {
              risk = "likely_overspend";
            } else if (projectedTotalSpend > cat.budgeted * 0.9) {
              risk = "watch";
            } else {
              risk = "safe";
            }

            const histAvg = historicalByCategory?.get(cat.id) ?? null;

            const entry: CategoryVelocity = {
              id: cat.id,
              name: cat.name,
              group_name: group.name,
              budgeted: milliunitsToCurrency(cat.budgeted),
              budgeted_display: formatCurrency(cat.budgeted, cf),
              spent_so_far: milliunitsToCurrency(spentSoFar),
              spent_so_far_display: formatCurrency(spentSoFar, cf),
              balance: milliunitsToCurrency(cat.balance),
              balance_display: formatCurrency(cat.balance, cf),
              daily_burn_rate: milliunitsToCurrency(Math.round(dailyBurnRate)),
              daily_burn_rate_display: formatCurrency(
                Math.round(dailyBurnRate),
                cf,
              ),
              projected_total_spend: milliunitsToCurrency(
                Math.round(projectedTotalSpend),
              ),
              projected_total_spend_display: formatCurrency(
                Math.round(projectedTotalSpend),
                cf,
              ),
              projected_remaining: milliunitsToCurrency(
                Math.round(projectedRemaining),
              ),
              projected_remaining_display: formatCurrency(
                Math.round(projectedRemaining),
                cf,
              ),
              risk,
              historical_monthly_avg:
                histAvg !== null ? milliunitsToCurrency(histAvg) : null,
              historical_monthly_avg_display:
                histAvg !== null ? formatCurrency(histAvg, cf) : null,
            };

            categories.push(entry);

            if (risk !== "safe") {
              const overspendAmount = Math.round(
                projectedTotalSpend - cat.budgeted,
              );
              atRisk.push({
                id: cat.id,
                name: cat.name,
                risk,
                projected_overspend: milliunitsToCurrency(
                  Math.max(0, overspendAmount),
                ),
                projected_overspend_display: formatCurrency(
                  Math.max(0, overspendAmount),
                  cf,
                ),
              });
            }
          }
        }

        // Sort at-risk by projected overspend descending
        atRisk.sort((a, b) => b.projected_overspend - a.projected_overspend);

        const likelyOverspendCount = atRisk.filter(
          (c) => c.risk === "likely_overspend",
        ).length;
        const watchCount = atRisk.filter((c) => c.risk === "watch").length;

        let overallStatus: string;
        if (likelyOverspendCount > 0) {
          overallStatus = "at_risk";
        } else if (watchCount > 0) {
          overallStatus = "watch";
        } else {
          overallStatus = "on_track";
        }

        return jsonToolResult({
          budget_id: context.ynabClient.resolveBudgetId(input.budget_id),
          month,
          day_of_month: dayOfMonth,
          days_in_month: daysInMonth,
          days_remaining: daysRemaining,
          overall_status: overallStatus,
          at_risk_count: atRisk.length,
          at_risk: atRisk,
          categories,
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to compute spending velocity."),
        );
      }
    },
  );
}

function getCurrentMonth(): string {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

async function computeHistoricalAverages(
  context: AppContext,
  budgetId: string | undefined,
  currentMonth: string,
  historyMonths: number,
): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  const counts = new Map<string, number>();

  const monthDate = new Date(currentMonth);

  const fetches: Promise<void>[] = [];
  for (let i = 1; i <= historyMonths; i++) {
    const past = new Date(monthDate.getFullYear(), monthDate.getMonth() - i, 1);
    const pastMonth = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, "0")}-01`;

    fetches.push(
      context.ynabClient
        .getCategories(budgetId, { month: pastMonth })
        .then((groups) => {
          for (const group of groups) {
            if (INTERNAL_GROUP_NAMES.has(group.name)) continue;
            for (const cat of group.categories) {
              if (cat.hidden || cat.deleted) continue;
              const spent = Math.abs(cat.activity);
              if (spent > 0) {
                totals.set(cat.id, (totals.get(cat.id) ?? 0) + spent);
                counts.set(cat.id, (counts.get(cat.id) ?? 0) + 1);
              }
            }
          }
        }),
    );
  }

  await Promise.all(fetches);

  const averages = new Map<string, number>();
  for (const [catId, total] of totals) {
    const count = counts.get(catId) ?? 1;
    averages.set(catId, Math.round(total / count));
  }

  return averages;
}
