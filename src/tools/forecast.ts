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

const forecastSchema = z.object({
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
  include_scheduled: z
    .boolean()
    .optional()
    .describe("Include scheduled transactions in forecast. Defaults to true."),
  history_months: z
    .number()
    .int()
    .min(1)
    .max(12)
    .optional()
    .describe(
      "Number of prior months for historical spending rate. Defaults to 3.",
    ),
});

type Confidence = "high" | "medium" | "low";

interface CategoryForecast {
  id: string;
  name: string;
  group_name: string;
  current_balance: number;
  current_balance_display: string;
  budgeted: number;
  budgeted_display: string;
  spent_so_far: number;
  spent_so_far_display: string;
  scheduled_outflows: number;
  scheduled_outflows_display: string;
  scheduled_inflows: number;
  scheduled_inflows_display: string;
  historical_daily_rate: number;
  historical_daily_rate_display: string;
  projected_additional_spend: number;
  projected_additional_spend_display: string;
  projected_end_balance: number;
  projected_end_balance_display: string;
  will_go_negative: boolean;
  confidence: Confidence;
}

export function registerForecastTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "forecast_category_balances",
    {
      title: "Forecast Category Balances",
      description:
        "Project end-of-month balances per category by combining current balance, " +
        "scheduled transactions for the remainder of the month, and historical " +
        "daily spending rates. Flags categories likely to go negative.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: forecastSchema,
    },
    async (input) => {
      try {
        const month = input.month ?? getCurrentMonth();
        const includeScheduled = input.include_scheduled ?? true;
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

        let dayOfMonth: number;
        if (today.getFullYear() === year && today.getMonth() === monthIndex) {
          dayOfMonth = today.getDate();
        } else if (today > monthDate) {
          dayOfMonth = daysInMonth;
        } else {
          dayOfMonth = 0;
        }

        const daysRemaining = Math.max(0, daysInMonth - dayOfMonth);
        const endOfMonth = getEndOfMonth(month);
        const tomorrowStr = getTomorrow(today, month, endOfMonth);

        // Fetch scheduled transactions for the rest of the month
        const scheduledOutflowsByCategory = new Map<string, number>();
        const scheduledInflowsByCategory = new Map<string, number>();

        if (includeScheduled && daysRemaining > 0 && tomorrowStr) {
          const scheduled = await context.ynabClient.getScheduledTransactions(
            input.budget_id,
            {
              dueAfter: tomorrowStr,
              dueBefore: endOfMonth,
            },
          );

          for (const st of scheduled) {
            if (!st.category_id) continue;
            if (st.amount < 0) {
              const current =
                scheduledOutflowsByCategory.get(st.category_id) ?? 0;
              scheduledOutflowsByCategory.set(
                st.category_id,
                current + Math.abs(st.amount),
              );
            } else {
              const current =
                scheduledInflowsByCategory.get(st.category_id) ?? 0;
              scheduledInflowsByCategory.set(
                st.category_id,
                current + st.amount,
              );
            }
          }
        }

        // Compute historical daily spending rates
        const historicalDailyRates = await computeHistoricalDailyRates(
          context,
          input.budget_id,
          month,
          historyMonths,
        );

        // Build forecasts
        const forecasts: CategoryForecast[] = [];
        const goingNegative: Array<{
          id: string;
          name: string;
          projected_end_balance: number;
          projected_end_balance_display: string;
        }> = [];

        for (const group of categoryGroups) {
          if (INTERNAL_GROUP_NAMES.has(group.name)) continue;

          for (const cat of group.categories) {
            if (cat.hidden || cat.deleted) continue;

            const scheduledOut = scheduledOutflowsByCategory.get(cat.id) ?? 0;
            const scheduledIn = scheduledInflowsByCategory.get(cat.id) ?? 0;
            const dailyRate = historicalDailyRates.get(cat.id) ?? 0;

            // Project additional unscheduled spending based on historical rate
            const projectedAdditionalSpend = Math.round(
              dailyRate * daysRemaining,
            );

            // End balance = current balance + scheduled inflows - scheduled outflows - projected spend
            const projectedEndBalance =
              cat.balance +
              scheduledIn -
              scheduledOut -
              projectedAdditionalSpend;

            const willGoNegative = projectedEndBalance < 0;

            // Confidence assessment
            let confidence: Confidence;
            if (dailyRate === 0 && scheduledOut === 0 && cat.activity === 0) {
              // No spending data at all - low confidence
              confidence = "low";
            } else if (dayOfMonth >= daysInMonth * 0.5 || dailyRate > 0) {
              // Halfway through month or have historical data
              confidence = "high";
            } else {
              confidence = "medium";
            }

            const entry: CategoryForecast = {
              id: cat.id,
              name: cat.name,
              group_name: group.name,
              current_balance: milliunitsToCurrency(cat.balance),
              current_balance_display: formatCurrency(cat.balance, cf),
              budgeted: milliunitsToCurrency(cat.budgeted),
              budgeted_display: formatCurrency(cat.budgeted, cf),
              spent_so_far: milliunitsToCurrency(Math.abs(cat.activity)),
              spent_so_far_display: formatCurrency(Math.abs(cat.activity), cf),
              scheduled_outflows: milliunitsToCurrency(scheduledOut),
              scheduled_outflows_display: formatCurrency(scheduledOut, cf),
              scheduled_inflows: milliunitsToCurrency(scheduledIn),
              scheduled_inflows_display: formatCurrency(scheduledIn, cf),
              historical_daily_rate: milliunitsToCurrency(dailyRate),
              historical_daily_rate_display: formatCurrency(dailyRate, cf),
              projected_additional_spend: milliunitsToCurrency(
                projectedAdditionalSpend,
              ),
              projected_additional_spend_display: formatCurrency(
                projectedAdditionalSpend,
                cf,
              ),
              projected_end_balance: milliunitsToCurrency(projectedEndBalance),
              projected_end_balance_display: formatCurrency(
                projectedEndBalance,
                cf,
              ),
              will_go_negative: willGoNegative,
              confidence,
            };

            forecasts.push(entry);

            if (willGoNegative) {
              goingNegative.push({
                id: cat.id,
                name: cat.name,
                projected_end_balance:
                  milliunitsToCurrency(projectedEndBalance),
                projected_end_balance_display: formatCurrency(
                  projectedEndBalance,
                  cf,
                ),
              });
            }
          }
        }

        // Sort going-negative by projected balance ascending (worst first)
        goingNegative.sort(
          (a, b) => a.projected_end_balance - b.projected_end_balance,
        );

        return jsonToolResult({
          budget_id: context.ynabClient.resolveBudgetId(input.budget_id),
          month,
          day_of_month: dayOfMonth,
          days_in_month: daysInMonth,
          days_remaining: daysRemaining,
          going_negative_count: goingNegative.length,
          going_negative: goingNegative,
          categories: forecasts,
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to forecast category balances."),
        );
      }
    },
  );
}

// --- Helpers ---

function getCurrentMonth(): string {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

function getEndOfMonth(monthStr: string): string {
  const date = new Date(monthStr);
  const year = date.getFullYear();
  const month = date.getMonth();
  const lastDay = new Date(year, month + 1, 0).getDate();
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

/**
 * Returns tomorrow's date as YYYY-MM-DD, clamped within the given month.
 * Returns null if we are already past the end of the month.
 */
function getTomorrow(
  today: Date,
  monthStart: string,
  monthEnd: string,
): string | null {
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  if (tomorrowStr > monthEnd) return null;
  if (tomorrowStr < monthStart) return monthStart;
  return tomorrowStr;
}

async function computeHistoricalDailyRates(
  context: AppContext,
  budgetId: string | undefined,
  currentMonth: string,
  historyMonths: number,
): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  let totalDays = 0;

  const monthDate = new Date(currentMonth);

  const fetches: Promise<number>[] = [];
  for (let i = 1; i <= historyMonths; i++) {
    const past = new Date(monthDate.getFullYear(), monthDate.getMonth() - i, 1);
    const pastMonth = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, "0")}-01`;
    const daysInPastMonth = new Date(
      past.getFullYear(),
      past.getMonth() + 1,
      0,
    ).getDate();

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
              }
            }
          }
          return daysInPastMonth;
        }),
    );
  }

  const dayResults = await Promise.all(fetches);
  totalDays = dayResults.reduce((sum, d) => sum + d, 0);

  const dailyRates = new Map<string, number>();
  if (totalDays > 0) {
    for (const [catId, total] of totals) {
      dailyRates.set(catId, Math.round(total / totalDays));
    }
  }

  return dailyRates;
}
