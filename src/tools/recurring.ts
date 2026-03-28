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
import type { ScheduledFrequency } from "../ynab/types.js";

const detectRecurringChargesSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe("Budget ID. Omit to use the last-used budget."),
  history_months: z
    .number()
    .int()
    .min(1)
    .max(36)
    .default(6)
    .describe("How many months of history to analyze."),
  min_occurrences: z
    .number()
    .int()
    .min(2)
    .max(50)
    .default(3)
    .describe("Minimum number of transactions to qualify as recurring."),
  include_matched: z
    .boolean()
    .default(true)
    .describe(
      "Include recurring charges that already have a matching scheduled transaction.",
    ),
});

interface PayeeTransactionGroup {
  payee_id: string;
  account_id: string;
  category_id: string | null;
  amounts: number[];
  dates: string[];
}

interface DetectedSubscription {
  payee_id: string;
  payee_name: string;
  category_id: string | null;
  category_name: string | null;
  detected_frequency_days: number;
  detected_frequency_label: string;
  occurrence_count: number;
  current_amount: number;
  current_amount_display: string;
  previous_amount: number | null;
  previous_amount_display: string | null;
  price_changed: boolean;
  price_change_percent: number | null;
  monthly_equivalent: number;
  monthly_equivalent_display: string;
  last_charge_date: string;
  next_expected_date: string;
  is_overdue: boolean;
  days_overdue: number;
  has_scheduled_transaction: boolean;
  scheduled_transaction_id: string | null;
  amount_variance: number;
}

function getHistorySinceDate(months: number): string {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date.toISOString().slice(0, 10);
}

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (mean === 0) return 0;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function intervalToLabel(medianDays: number): string {
  if (medianDays >= 5 && medianDays <= 9) return "weekly";
  if (medianDays >= 12 && medianDays <= 16) return "biweekly";
  if (medianDays >= 25 && medianDays <= 35) return "monthly";
  if (medianDays >= 80 && medianDays <= 100) return "quarterly";
  if (medianDays >= 340 && medianDays <= 400) return "annual";
  return `every ~${Math.round(medianDays)} days`;
}

function labelToScheduledFrequency(label: string): ScheduledFrequency {
  switch (label) {
    case "weekly":
      return "weekly";
    case "monthly":
    case "biweekly":
    case "quarterly":
      return "monthly";
    case "annual":
      return "yearly";
    default:
      return "monthly";
  }
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + Math.round(days));
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / msPerDay);
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export function registerRecurringTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "detect_recurring_charges",
    {
      title: "Detect Recurring Charges",
      description:
        "Identify subscriptions and recurring charges from transaction patterns. " +
        "Analyzes transaction history to detect regular outflows, estimates frequency, " +
        "flags price changes, and cross-references with scheduled transactions. " +
        "Returns create_scheduled_actions for unmatched recurring charges (suggestions only).",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: detectRecurringChargesSchema,
    },
    async (input) => {
      try {
        const resolvedBudgetId = await context.ynabClient.resolveRealBudgetId(
          input.budget_id,
        );
        const historyMonths = input.history_months;
        const minOccurrences = input.min_occurrences;
        const includeMatched = input.include_matched;
        const sinceDate = getHistorySinceDate(historyMonths);

        const [transactions, scheduledTransactions, lookups, settings] =
          await Promise.all([
            context.ynabClient.getTransactionsInRange(
              resolvedBudgetId,
              sinceDate,
            ),
            context.ynabClient.getScheduledTransactions(resolvedBudgetId),
            context.ynabClient.getNameLookup(resolvedBudgetId),
            context.ynabClient.getBudgetSettings(resolvedBudgetId),
          ]);

        const currencyFormat = settings.currency_format;

        // Step 4: Group transactions by payee_id (outflows only, skip transfers)
        const payeeGroups = new Map<string, PayeeTransactionGroup>();

        for (const tx of transactions) {
          if (tx.amount >= 0) continue;
          if (!tx.payee_id) continue;
          if (tx.transfer_account_id != null) continue;

          const key = tx.payee_id;
          let group = payeeGroups.get(key);
          if (!group) {
            group = {
              payee_id: tx.payee_id,
              account_id: tx.account_id,
              category_id: tx.category_id ?? null,
              amounts: [],
              dates: [],
            };
            payeeGroups.set(key, group);
          }
          group.amounts.push(tx.amount);
          group.dates.push(tx.date);
          // Use the most recent category
          if (tx.category_id) {
            group.category_id = tx.category_id;
          }
        }

        // Build a set of payee_ids covered by scheduled transactions
        const scheduledByPayeeId = new Map<
          string,
          { id: string; payee_id: string }
        >();
        for (const stx of scheduledTransactions) {
          if (stx.payee_id) {
            scheduledByPayeeId.set(stx.payee_id, {
              id: stx.id,
              payee_id: stx.payee_id,
            });
          }
        }

        // Step 5: Analyze each payee group
        const subscriptions: DetectedSubscription[] = [];

        for (const group of payeeGroups.values()) {
          if (group.amounts.length < minOccurrences) continue;

          // Sort by date ascending
          const indices = group.dates
            .map((_, i) => i)
            .sort((a, b) => group.dates[a].localeCompare(group.dates[b]));
          const sortedDates = indices.map((i) => group.dates[i]);
          const sortedAmounts = indices.map((i) => group.amounts[i]);

          // Compute inter-transaction intervals
          const intervals: number[] = [];
          for (let i = 1; i < sortedDates.length; i++) {
            intervals.push(daysBetween(sortedDates[i - 1], sortedDates[i]));
          }

          if (intervals.length === 0) continue;

          const medianInterval = computeMedian(intervals);
          if (medianInterval < 4) continue; // Too frequent to be a subscription

          const cv = coefficientOfVariation(intervals);
          if (cv >= 0.3) continue; // Too irregular

          const frequencyLabel = intervalToLabel(medianInterval);

          // Check last 2 amounts for price changes
          const lastAmount = sortedAmounts[sortedAmounts.length - 1];
          const prevAmount =
            sortedAmounts.length >= 2
              ? sortedAmounts[sortedAmounts.length - 2]
              : null;
          const absLast = Math.abs(lastAmount);
          const absPrev = prevAmount !== null ? Math.abs(prevAmount) : null;
          let priceChanged = false;
          let priceChangePercent: number | null = null;
          if (absPrev !== null && absPrev > 0) {
            const pctDiff = ((absLast - absPrev) / absPrev) * 100;
            if (Math.abs(pctDiff) > 2) {
              priceChanged = true;
              priceChangePercent = Math.round(pctDiff * 100) / 100;
            }
          }

          // Compute next expected date and overdue status
          const lastChargeDate = sortedDates[sortedDates.length - 1];
          const nextExpectedDate = addDays(lastChargeDate, medianInterval);
          const today = todayStr();
          const daysOverdue = daysBetween(nextExpectedDate, today);
          const isOverdue = daysOverdue > 0;

          // Cross-reference with scheduled transactions
          const scheduledMatch = scheduledByPayeeId.get(group.payee_id);
          const hasScheduled = scheduledMatch !== undefined;

          if (!includeMatched && hasScheduled) continue;

          // Monthly equivalent
          const monthlyEquivalent = Math.round(
            absLast * (30.44 / medianInterval),
          );

          // Amount variance (stddev of absolute amounts)
          const absAmounts = sortedAmounts.map(Math.abs);
          const meanAmt =
            absAmounts.reduce((s, v) => s + v, 0) / absAmounts.length;
          const varianceAmt =
            absAmounts.reduce((s, v) => s + (v - meanAmt) ** 2, 0) /
            absAmounts.length;
          const amountVariance = Math.round(Math.sqrt(varianceAmt));

          const payeeName =
            lookups.payeeById.get(group.payee_id) ?? "Unknown Payee";
          const catInfo = group.category_id
            ? lookups.categoryById.get(group.category_id)
            : null;

          subscriptions.push({
            payee_id: group.payee_id,
            payee_name: payeeName,
            category_id: group.category_id,
            category_name: catInfo?.name ?? null,
            detected_frequency_days: Math.round(medianInterval),
            detected_frequency_label: frequencyLabel,
            occurrence_count: sortedAmounts.length,
            current_amount: milliunitsToCurrency(absLast),
            current_amount_display: formatCurrency(absLast, currencyFormat),
            previous_amount:
              absPrev !== null ? milliunitsToCurrency(absPrev) : null,
            previous_amount_display:
              absPrev !== null ? formatCurrency(absPrev, currencyFormat) : null,
            price_changed: priceChanged,
            price_change_percent: priceChangePercent,
            monthly_equivalent: milliunitsToCurrency(monthlyEquivalent),
            monthly_equivalent_display: formatCurrency(
              monthlyEquivalent,
              currencyFormat,
            ),
            last_charge_date: lastChargeDate,
            next_expected_date: nextExpectedDate,
            is_overdue: isOverdue,
            days_overdue: Math.max(0, daysOverdue),
            has_scheduled_transaction: hasScheduled,
            scheduled_transaction_id: scheduledMatch?.id ?? null,
            amount_variance: milliunitsToCurrency(amountVariance),
          });
        }

        // Sort by monthly equivalent descending
        subscriptions.sort(
          (a, b) => b.monthly_equivalent - a.monthly_equivalent,
        );

        // Step 6: Build create_scheduled_actions for unmatched
        const createScheduledActions = subscriptions
          .filter((sub) => !sub.has_scheduled_transaction)
          .map((sub) => {
            const group = payeeGroups.get(sub.payee_id)!;
            const frequency = labelToScheduledFrequency(
              sub.detected_frequency_label,
            );
            return {
              account_id: group.account_id,
              date: sub.next_expected_date,
              amount: -Math.round(sub.current_amount * 1000),
              payee_id: sub.payee_id,
              category_id: sub.category_id,
              frequency,
              memo: `Auto-detected ${sub.detected_frequency_label} charge`,
            };
          });

        const unmatchedCount = subscriptions.filter(
          (s) => !s.has_scheduled_transaction,
        ).length;

        const totalMonthlyCostMilliunits = subscriptions.reduce(
          (sum, s) => sum + Math.round(s.monthly_equivalent * 1000),
          0,
        );

        return jsonToolResult({
          budget_id: resolvedBudgetId,
          subscription_count: subscriptions.length,
          unmatched_count: unmatchedCount,
          total_monthly_cost: milliunitsToCurrency(totalMonthlyCostMilliunits),
          total_monthly_cost_display: formatCurrency(
            totalMonthlyCostMilliunits,
            currencyFormat,
          ),
          subscriptions,
          create_scheduled_actions: createScheduledActions,
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to detect recurring charges."),
        );
      }
    },
  );
}
