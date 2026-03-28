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

function buildMonthKeys(monthsBack: number): string[] {
  const now = new Date();
  const keys: string[] = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
    );
  }
  return keys;
}

function formatAmount(
  milliunits: number,
  currencyFormat?: CurrencyFormatLike,
): { value: number; display: string } {
  return {
    value: milliunitsToCurrency(milliunits),
    display: formatCurrency(milliunits, currencyFormat),
  };
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
        "Monthly income vs expense breakdown with savings rate calculation and trend detection across months.",
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
        const monthKeys = buildMonthKeys(monthCount);

        const settings = await context.ynabClient.getBudgetSettings(
          input.budget_id,
        );
        const cf = settings.currency_format;

        // Fetch all month summaries in parallel
        const monthSummaries = await Promise.all(
          monthKeys.map((monthKey) =>
            context.ynabClient.getMonthSummary(
              input.budget_id,
              `${monthKey}-01`,
            ),
          ),
        );

        // Build per-month breakdown
        let totalIncome = 0;
        let totalExpenses = 0;

        const months = monthSummaries.map((summary, idx) => {
          const income = summary.income; // milliunits, positive
          const expenses = Math.abs(summary.activity); // activity is negative for spending
          const net = income - expenses;
          const savingsRate =
            income > 0 ? Math.round((net / income) * 10000) / 100 : 0;

          totalIncome += income;
          totalExpenses += expenses;

          const incFmt = formatAmount(income, cf);
          const expFmt = formatAmount(expenses, cf);
          const netFmt = formatAmount(net, cf);

          return {
            month: monthKeys[idx],
            income: incFmt.value,
            income_display: incFmt.display,
            expenses: expFmt.value,
            expenses_display: expFmt.display,
            net: netFmt.value,
            net_display: netFmt.display,
            savings_rate: savingsRate,
          };
        });

        // Compute averages
        const avgIncome = Math.round(totalIncome / monthCount);
        const avgExpenses = Math.round(totalExpenses / monthCount);
        const avgNet = Math.round((totalIncome - totalExpenses) / monthCount);
        const avgSavingsRate =
          totalIncome > 0
            ? Math.round(
                ((totalIncome - totalExpenses) / totalIncome) * 10000,
              ) / 100
            : 0;

        const avgIncomeFmt = formatAmount(avgIncome, cf);
        const avgExpensesFmt = formatAmount(avgExpenses, cf);
        const avgNetFmt = formatAmount(avgNet, cf);

        // Compute trend: recent 3 months avg savings rate vs prior months
        const recentWindow = Math.min(3, Math.floor(monthCount / 2));
        const recentMonths = months.slice(-recentWindow);
        const priorMonths = months.slice(0, -recentWindow);

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
          months,
          averages: {
            avg_income: avgIncomeFmt.value,
            avg_income_display: avgIncomeFmt.display,
            avg_expenses: avgExpensesFmt.value,
            avg_expenses_display: avgExpensesFmt.display,
            avg_net: avgNetFmt.value,
            avg_net_display: avgNetFmt.display,
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
