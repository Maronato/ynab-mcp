import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import {
  endOfMonthString,
  monthKeysBack,
  todayString,
} from "../shared/dates.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { extractErrorMessage } from "../ynab/errors.js";
import {
  asCurrency,
  asMilliunits,
  currencyToMilliunits,
  milliunitsToCurrency,
} from "../ynab/format.js";

const incomeExpenseSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe("Budget ID. Omit to use the last-used budget."),
  months: z
    .number()
    .int()
    .min(2)
    .max(12)
    .default(6)
    .describe("Number of months to analyze (2-12)."),
});

function toCurrency(milliunits: number): number {
  return milliunitsToCurrency(asMilliunits(milliunits));
}

export function registerIncomeExpenseTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "get_income_expense_summary",
    {
      title: "Get Income vs Expense Summary",
      description:
        "Monthly income vs expense breakdown with savings rate calculation and " +
        "trend detection across months. The in-progress current month is listed " +
        "marked partial, but excluded from averages and the trend.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: incomeExpenseSchema,
    },
    async (input) => {
      try {
        const monthCount = input.months ?? 6;
        const monthKeys = monthKeysBack(monthCount);

        const settings = await context.ynabClient.getBudgetSettings(
          input.budget_id,
        );

        // Fetch all month summaries in parallel
        const monthSummaries = await Promise.all(
          monthKeys.map((monthKey) =>
            context.ynabClient.getMonthSummary(
              input.budget_id,
              `${monthKey}-01`,
            ),
          ),
        );

        // The last month key is the current month; treat it as partial until
        // its final day and keep it out of averages and the trend windows so
        // an incomplete month does not read as a spending drop.
        const currentMonthPartial =
          todayString() <
          endOfMonthString(`${monthKeys[monthKeys.length - 1]}-01`);

        // Build per-month breakdown
        const months = monthSummaries.map((summary, idx) => {
          const income = summary.income; // milliunits, positive
          const expenses = Math.abs(summary.activity); // activity is negative for spending
          const net = income - expenses;
          const savingsRate =
            income > 0 ? Math.round((net / income) * 10000) / 100 : 0;

          return {
            month: monthKeys[idx],
            income: toCurrency(income),
            expenses: toCurrency(expenses),
            net: toCurrency(net),
            savings_rate: savingsRate,
            ...(currentMonthPartial &&
              idx === monthSummaries.length - 1 && { partial: true }),
          };
        });

        // Averages and trend use complete months only
        const completeMonths = currentMonthPartial
          ? months.slice(0, -1)
          : months;
        const completeCount = completeMonths.length;
        const totalIncome = completeMonths.reduce(
          (sum, m) => sum + currencyToMilliunits(asCurrency(m.income)),
          0,
        );
        const totalExpenses = completeMonths.reduce(
          (sum, m) => sum + currencyToMilliunits(asCurrency(m.expenses)),
          0,
        );

        const avgIncome =
          completeCount > 0 ? Math.round(totalIncome / completeCount) : 0;
        const avgExpenses =
          completeCount > 0 ? Math.round(totalExpenses / completeCount) : 0;
        const avgNet =
          completeCount > 0
            ? Math.round((totalIncome - totalExpenses) / completeCount)
            : 0;
        const avgSavingsRate =
          totalIncome > 0
            ? Math.round(
                ((totalIncome - totalExpenses) / totalIncome) * 10000,
              ) / 100
            : 0;

        // Compute trend: recent months avg savings rate vs prior months,
        // over complete months only
        const recentWindow = Math.min(3, Math.floor(completeCount / 2));
        const recentMonths =
          recentWindow > 0 ? completeMonths.slice(-recentWindow) : [];
        const priorMonths =
          recentWindow > 0 ? completeMonths.slice(0, -recentWindow) : [];

        const recentTotalIncome = recentMonths.reduce(
          (sum, m) => sum + m.income,
          0,
        );
        const recentTotalExpenses = recentMonths.reduce(
          (sum, m) => sum + m.expenses,
          0,
        );
        const recentSavingsRate =
          recentTotalIncome > 0
            ? Math.round(
                ((recentTotalIncome - recentTotalExpenses) /
                  recentTotalIncome) *
                  10000,
              ) / 100
            : 0;

        const priorTotalIncome = priorMonths.reduce(
          (sum, m) => sum + m.income,
          0,
        );
        const priorTotalExpenses = priorMonths.reduce(
          (sum, m) => sum + m.expenses,
          0,
        );
        const priorSavingsRate =
          priorTotalIncome > 0
            ? Math.round(
                ((priorTotalIncome - priorTotalExpenses) / priorTotalIncome) *
                  10000,
              ) / 100
            : 0;

        const savingsDiff = recentSavingsRate - priorSavingsRate;
        let direction: "improving" | "declining" | "stable";
        if (savingsDiff > 2) {
          direction = "improving";
        } else if (savingsDiff < -2) {
          direction = "declining";
        } else {
          direction = "stable";
        }

        return jsonToolResult({
          budget_id: context.ynabClient.resolveBudgetId(input.budget_id),
          currency: settings.currency_format?.iso_code ?? null,
          current_month_partial: currentMonthPartial,
          months,
          averages: {
            avg_income: toCurrency(avgIncome),
            avg_expenses: toCurrency(avgExpenses),
            avg_net: toCurrency(avgNet),
            avg_savings_rate: avgSavingsRate,
          },
          trend: {
            direction,
            recent_savings_rate: recentSavingsRate,
            prior_savings_rate: priorSavingsRate,
          },
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(
            error,
            "Failed to compute income/expense summary.",
          ),
        );
      }
    },
  );
}
