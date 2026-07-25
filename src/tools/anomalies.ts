import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { dateDaysAgo, dateMonthsAgo, daysBetween } from "../shared/dates.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { extractErrorMessage } from "../ynab/errors.js";
import {
  asMilliunits,
  formatCurrency,
  milliunitsToCurrency,
} from "../ynab/format.js";

/**
 * Floor for the deviation comparison scale, in milliunits. Payees with a
 * near-constant history have a tiny (or zero) standard deviation, which would
 * otherwise make any difference at all look infinitely significant.
 */
const MIN_DEVIATION_SCALE = 500;

/**
 * Minimum absolute deviation, in milliunits, before an anomaly can reach the
 * top severity. Keeps sub-dollar wobble on cheap recurring payees from
 * outranking genuinely large surprises in the sorted output.
 */
const ALERT_MIN_DEVIATION = 25_000;

const sensitivityLevels = ["low", "medium", "high"] as const;
type Sensitivity = (typeof sensitivityLevels)[number];

type AnomalyType = "unusual_amount" | "new_payee_large" | "potential_duplicate";
type Severity = "info" | "warning" | "alert";

const detectAnomaliesSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe("Budget ID. Omit to use the last-used budget."),
  since_date: z
    .string()
    .optional()
    .describe(
      "Start of detection window in YYYY-MM-DD format. Defaults to 30 days ago.",
    ),
  sensitivity: z
    .enum(sensitivityLevels)
    .default("medium")
    .describe(
      "Detection sensitivity: low (3-sigma), medium (2-sigma), high (1.5-sigma).",
    ),
  history_months: z
    .number()
    .int()
    .min(1)
    .max(36)
    .default(6)
    .describe("Months of history to build baseline statistics from."),
});

interface AnomalyEntry {
  transaction_id: string;
  date: string;
  payee_name: string | null;
  amount: number;
  category_name: string | null;
  anomaly_type: AnomalyType;
  severity: Severity;
  detail: string;
  reference: Record<string, unknown>;
}

function getDefaultSinceDate(): string {
  return dateDaysAgo(30);
}

function getHistorySinceDate(months: number): string {
  return dateMonthsAgo(months);
}

function sigmaThreshold(sensitivity: Sensitivity): number {
  switch (sensitivity) {
    case "low":
      return 3;
    case "medium":
      return 2;
    case "high":
      return 1.5;
  }
}

export function registerAnomalyTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "detect_anomalies",
    {
      title: "Detect Anomalies",
      description:
        "Find unusual transactions: abnormal amounts for known payees, " +
        "large charges from new payees, and potential duplicates. Compares " +
        "each transaction against a baseline built from that payee's other " +
        "transactions (the transaction itself is excluded). For payees whose " +
        "history is near-constant the comparison scale is floored, in which " +
        'case scale_basis is "floor" and scale_multiple is a multiple of ' +
        "that floor rather than a standard deviation.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: detectAnomaliesSchema,
    },
    async (input) => {
      try {
        const resolvedBudgetId = await context.ynabClient.resolveRealBudgetId(
          input.budget_id,
        );
        const sinceDate = input.since_date ?? getDefaultSinceDate();
        const sensitivity = input.sensitivity;
        const historyMonths = input.history_months;
        const historySinceDate = getHistorySinceDate(historyMonths);
        const sigma = sigmaThreshold(sensitivity);

        const [allTransactions, lookups, settings] = await Promise.all([
          context.ynabClient.getTransactionsInRange(
            resolvedBudgetId,
            historySinceDate,
          ),
          context.ynabClient.getNameLookup(resolvedBudgetId),
          context.ynabClient.getBudgetSettings(resolvedBudgetId),
        ]);

        const currencyFormat = settings.currency_format;

        // Build per-payee history from all transactions (outflows, non-transfers).
        // Sums and sums-of-squares allow O(1) leave-one-out statistics below.
        interface PayeeStats {
          count: number;
          sum: number;
          sumSq: number;
        }
        const payeeHistory = new Map<string, PayeeStats>();
        const allOutflowAmounts: number[] = [];

        for (const tx of allTransactions) {
          if (tx.amount >= 0) continue;
          if (tx.transfer_account_id != null) continue;
          const absAmount = Math.abs(tx.amount);
          allOutflowAmounts.push(absAmount);

          if (!tx.payee_id) continue;
          let stats = payeeHistory.get(tx.payee_id);
          if (!stats) {
            stats = { count: 0, sum: 0, sumSq: 0 };
            payeeHistory.set(tx.payee_id, stats);
          }
          stats.count += 1;
          stats.sum += absAmount;
          stats.sumSq += absAmount * absAmount;
        }

        // Leave-one-out mean/stddev: the tested transaction is excluded from
        // its own baseline so a large outlier cannot mask itself.
        function baselineExcluding(
          stats: PayeeStats,
          amount: number,
        ): { n: number; mean: number; stddev: number } {
          const n = stats.count - 1;
          if (n < 1) return { n, mean: 0, stddev: 0 };
          const mean = (stats.sum - amount) / n;
          const variance = Math.max(
            0,
            (stats.sumSq - amount * amount) / n - mean * mean,
          );
          return { n, mean, stddev: Math.sqrt(variance) };
        }

        // Compute 75th percentile of all outflow amounts
        const sortedOutflows = [...allOutflowAmounts].sort((a, b) => a - b);
        const p75Index = Math.floor(sortedOutflows.length * 0.75);
        const p75Amount =
          sortedOutflows.length > 0 ? sortedOutflows[p75Index] : 0;

        // Filter to recent transactions only (within detection window)
        const recentTransactions = allTransactions.filter(
          (tx) => tx.date >= sinceDate,
        );

        const anomalies: AnomalyEntry[] = [];
        const seenAnomalyKeys = new Set<string>();

        // Check each recent outflow transaction
        for (const tx of recentTransactions) {
          if (tx.amount >= 0) continue;
          if (tx.transfer_account_id != null) continue;
          const absAmount = Math.abs(tx.amount);

          const payeeName = tx.payee_id
            ? (lookups.payeeById.get(tx.payee_id) ?? null)
            : (tx.payee_name ?? null);
          const catInfo = tx.category_id
            ? lookups.categoryById.get(tx.category_id)
            : null;

          // Check 1: Unusual amount for known payee
          if (tx.payee_id) {
            const stats = payeeHistory.get(tx.payee_id);
            const baseline = stats ? baselineExcluding(stats, absAmount) : null;
            if (baseline && baseline.n >= 5 && baseline.mean > 0) {
              // Floor the comparison scale so a perfectly consistent history
              // (stddev 0, e.g. a fixed subscription) still flags meaningful
              // deviations instead of being skipped. When the floor binds,
              // the resulting multiple is NOT a standard deviation, so it is
              // reported and described as a scale multiple instead.
              const scale = Math.max(
                baseline.stddev,
                baseline.mean * 0.05,
                MIN_DEVIATION_SCALE,
              );
              const usedStddev = scale === baseline.stddev;
              const deviation = Math.abs(absAmount - baseline.mean);
              if (deviation > sigma * scale) {
                const key = `unusual_amount:${tx.id}`;
                if (!seenAnomalyKeys.has(key)) {
                  seenAnomalyKeys.add(key);
                  const multiple = Math.round((deviation / scale) * 10) / 10;
                  // Severity needs both a large relative multiple and a
                  // materially large absolute deviation: without the amount
                  // gate a sub-dollar overage on a cheap recurring payee
                  // outranked a several-hundred-unit surprise.
                  const severity: Severity =
                    multiple >= 3 && deviation >= ALERT_MIN_DEVIATION
                      ? "alert"
                      : "warning";
                  const scaleDescription = usedStddev
                    ? `${multiple} standard deviations`
                    : `${multiple}x the expected variation (${formatCurrency(asMilliunits(Math.round(scale)), currencyFormat)}, a floor applied because this payee's history is near-constant)`;
                  anomalies.push({
                    transaction_id: tx.id,
                    date: tx.date,
                    payee_name: payeeName,
                    amount: milliunitsToCurrency(asMilliunits(tx.amount)),
                    category_name: catInfo?.name ?? null,
                    anomaly_type: "unusual_amount",
                    severity,
                    detail:
                      `Amount ${formatCurrency(asMilliunits(absAmount), currencyFormat)} is ${scaleDescription} ` +
                      `from the mean of ${formatCurrency(asMilliunits(Math.round(baseline.mean)), currencyFormat)} ` +
                      `for ${payeeName ?? "this payee"} (${baseline.n} other transactions).`,
                    reference: {
                      payee_mean: milliunitsToCurrency(
                        asMilliunits(Math.round(baseline.mean)),
                      ),
                      payee_stddev: milliunitsToCurrency(
                        asMilliunits(Math.round(baseline.stddev)),
                      ),
                      deviation: milliunitsToCurrency(
                        asMilliunits(Math.round(deviation)),
                      ),
                      // The scale the multiple is measured against, and
                      // whether it is the real stddev or the floor.
                      comparison_scale: milliunitsToCurrency(
                        asMilliunits(Math.round(scale)),
                      ),
                      scale_basis: usedStddev ? "stddev" : "floor",
                      scale_multiple: multiple,
                    },
                  });
                }
              }
            }
          }

          // Check 2: New payee with large amount
          if (tx.payee_id) {
            const stats = payeeHistory.get(tx.payee_id);
            const historyCount = stats?.count ?? 0;
            // "New" means all occurrences are in the recent window
            const allRecent = stats
              ? stats.count <=
                recentTransactions.filter(
                  (r) => r.payee_id === tx.payee_id && r.amount < 0,
                ).length
              : true;
            if (
              allRecent &&
              historyCount <= 2 &&
              absAmount > p75Amount &&
              p75Amount > 0
            ) {
              const key = `new_payee_large:${tx.id}`;
              if (!seenAnomalyKeys.has(key)) {
                seenAnomalyKeys.add(key);
                anomalies.push({
                  transaction_id: tx.id,
                  date: tx.date,
                  payee_name: payeeName,
                  amount: milliunitsToCurrency(asMilliunits(tx.amount)),
                  category_name: catInfo?.name ?? null,
                  anomaly_type: "new_payee_large",
                  severity: "warning",
                  detail:
                    `New payee "${payeeName ?? "Unknown"}" with a charge of ` +
                    `${formatCurrency(asMilliunits(absAmount), currencyFormat)}, which exceeds the 75th percentile ` +
                    `of all spending (${formatCurrency(asMilliunits(Math.round(p75Amount)), currencyFormat)}).`,
                  reference: {
                    p75_threshold: milliunitsToCurrency(
                      asMilliunits(Math.round(p75Amount)),
                    ),
                    payee_history_count: historyCount,
                  },
                });
              }
            }
          }

          // Check 3: Potential duplicate (same payee, similar amount, within 3 days)
          if (tx.payee_id) {
            for (const other of recentTransactions) {
              if (other.id === tx.id) continue;
              if (other.id <= tx.id) continue; // Only flag each pair once
              if (other.payee_id !== tx.payee_id) continue;
              if (other.amount >= 0) continue;
              if (other.transfer_account_id != null) continue;

              const otherAbs = Math.abs(other.amount);
              const amountDiff = Math.abs(absAmount - otherAbs);
              const maxAmt = Math.max(absAmount, otherAbs);
              const withinTolerance = maxAmt > 0 && amountDiff / maxAmt <= 0.05;
              const withinDays =
                Math.abs(daysBetween(tx.date, other.date)) <= 3;

              if (withinTolerance && withinDays) {
                const key = `potential_duplicate:${tx.id}:${other.id}`;
                if (!seenAnomalyKeys.has(key)) {
                  seenAnomalyKeys.add(key);
                  anomalies.push({
                    transaction_id: tx.id,
                    date: tx.date,
                    payee_name: payeeName,
                    amount: milliunitsToCurrency(asMilliunits(tx.amount)),
                    category_name: catInfo?.name ?? null,
                    anomaly_type: "potential_duplicate",
                    severity: "info",
                    detail:
                      `Possible duplicate: two charges to "${payeeName ?? "Unknown"}" ` +
                      `(${formatCurrency(asMilliunits(tx.amount), currencyFormat)} on ${tx.date} and ` +
                      `${formatCurrency(asMilliunits(other.amount), currencyFormat)} on ${other.date}) ` +
                      `within 3 days with similar amounts.`,
                    reference: {
                      duplicate_candidate_id: other.id,
                      duplicate_candidate_date: other.date,
                      duplicate_candidate_amount: milliunitsToCurrency(
                        asMilliunits(other.amount),
                      ),
                    },
                  });
                }
              }
            }
          }
        }

        // Sort by severity (alert > warning > info), then by absolute amount descending
        const severityOrder: Record<Severity, number> = {
          alert: 0,
          warning: 1,
          info: 2,
        };
        anomalies.sort((a, b) => {
          const sevCmp = severityOrder[a.severity] - severityOrder[b.severity];
          if (sevCmp !== 0) return sevCmp;
          return Math.abs(b.amount) - Math.abs(a.amount);
        });

        return jsonToolResult({
          budget_id: resolvedBudgetId,
          anomaly_count: anomalies.length,
          anomalies,
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to detect anomalies."),
        );
      }
    },
  );
}
