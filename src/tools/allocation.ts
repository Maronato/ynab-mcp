import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { extractErrorMessage } from "../ynab/errors.js";
import {
  type CurrencyFormatLike,
  currencyToMilliunits,
  formatCurrency,
  milliunitsToCurrency,
} from "../ynab/format.js";

const INTERNAL_GROUP_NAMES = new Set([
  "Internal Master Category",
  "Credit Card Payments",
]);

const budgetAllocationSchema = z.object({
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
  available_amount: z
    .number()
    .optional()
    .describe(
      "Amount (in currency, e.g. 500.00) to allocate. If omitted, uses Ready to Assign.",
    ),
  history_months: z
    .number()
    .int()
    .min(1)
    .max(12)
    .optional()
    .describe(
      "Number of prior months for historical average spending. Defaults to 3.",
    ),
});

interface AllocationEntry {
  category_id: string;
  category_name: string;
  group_name: string;
  priority:
    | "P1_bills_due"
    | "P2_monthly_contribution"
    | "P3_variable_spending"
    | "P4_savings";
  amount: number;
  amount_display: string;
  reason: string;
}

export function registerAllocationTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "suggest_budget_allocation",
    {
      title: "Suggest Budget Allocation",
      description:
        "When Ready to Assign > 0 (or a custom amount is given), compute an optimal " +
        "allocation across categories based on priority: P1 bills due this month, " +
        "P2 monthly contribution targets, P3 variable spending needs, P4 savings goals. " +
        "Returns suggestions and set_budget_actions for the LLM to apply via set_category_budgets.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: budgetAllocationSchema,
    },
    async (input) => {
      try {
        const month = input.month ?? getCurrentMonth();

        const [monthSummary, categoryGroups, scheduledTransactions, settings] =
          await Promise.all([
            context.ynabClient.getMonthSummary(input.budget_id, month),
            context.ynabClient.getCategories(input.budget_id, { month }),
            context.ynabClient.getScheduledTransactions(input.budget_id, {
              dueAfter: month,
              dueBefore: getEndOfMonth(month),
            }),
            context.ynabClient.getBudgetSettings(input.budget_id),
          ]);

        const cf = settings.currency_format;

        // Determine available amount
        let availableMilliunits: number;
        if (input.available_amount !== undefined) {
          availableMilliunits = currencyToMilliunits(input.available_amount);
        } else {
          availableMilliunits = monthSummary.to_be_budgeted;
        }

        if (availableMilliunits <= 0) {
          return jsonToolResult({
            budget_id: context.ynabClient.resolveBudgetId(input.budget_id),
            month,
            available_amount: milliunitsToCurrency(availableMilliunits),
            available_amount_display: formatCurrency(availableMilliunits, cf),
            message:
              availableMilliunits === 0
                ? "Nothing available to allocate. Ready to Assign is zero."
                : "Ready to Assign is negative. Resolve overspending before allocating.",
            allocations: [],
            set_budget_actions: [],
          });
        }

        // Build historical averages for P3 variable spending
        const historyMonths = input.history_months ?? 3;
        const historicalAvg = await computeHistoricalAverages(
          context,
          input.budget_id,
          month,
          historyMonths,
        );

        // Build a set of category IDs with scheduled transactions this month
        const scheduledByCategoryId = new Map<string, number>();
        for (const st of scheduledTransactions) {
          if (!st.category_id) continue;
          const existing = scheduledByCategoryId.get(st.category_id) ?? 0;
          scheduledByCategoryId.set(
            st.category_id,
            existing + Math.abs(st.amount),
          );
        }

        // Categorize each category into priority buckets
        const p1Bills: Array<{
          cat: CategoryInfo;
          needed: number;
          reason: string;
        }> = [];
        const p2Monthly: Array<{
          cat: CategoryInfo;
          needed: number;
          reason: string;
        }> = [];
        const p3Variable: Array<{
          cat: CategoryInfo;
          needed: number;
          reason: string;
        }> = [];
        const p4Savings: Array<{
          cat: CategoryInfo;
          needed: number;
          reason: string;
        }> = [];

        for (const group of categoryGroups) {
          if (INTERNAL_GROUP_NAMES.has(group.name)) continue;

          for (const cat of group.categories) {
            if (cat.hidden || cat.deleted) continue;

            const info: CategoryInfo = {
              id: cat.id,
              name: cat.name,
              group_name: group.name,
              budgeted: cat.budgeted,
              balance: cat.balance,
              activity: cat.activity,
              goal_type: cat.goal_type ?? null,
              goal_target: cat.goal_target ?? null,
              goal_under_funded: cat.goal_under_funded ?? null,
              goal_target_date: cat.goal_target_date ?? null,
            };

            // P1: NEED targets (bills) with dates this month, or categories with
            // scheduled transactions due this month that are underfunded
            if (
              cat.goal_type === "NEED" &&
              cat.goal_under_funded != null &&
              cat.goal_under_funded > 0
            ) {
              // NEED goals with a specific due date are bills
              if (cat.goal_target_date) {
                p1Bills.push({
                  cat: info,
                  needed: cat.goal_under_funded,
                  reason: `Bill due (NEED target, date: ${cat.goal_target_date}). Underfunded.`,
                });
                continue;
              }
              // NEED goals without a date but with scheduled transactions are also bills
              if (scheduledByCategoryId.has(cat.id)) {
                p1Bills.push({
                  cat: info,
                  needed: cat.goal_under_funded,
                  reason: "Scheduled transaction due this month. Underfunded.",
                });
                continue;
              }
              // NEED goals without date or scheduled are monthly needs (still P1-ish)
              p1Bills.push({
                cat: info,
                needed: cat.goal_under_funded,
                reason: "Monthly NEED target. Underfunded.",
              });
              continue;
            }

            // P2: MF (monthly funding) targets that are underfunded
            if (
              cat.goal_type === "MF" &&
              cat.goal_under_funded != null &&
              cat.goal_under_funded > 0
            ) {
              p2Monthly.push({
                cat: info,
                needed: cat.goal_under_funded,
                reason: "Monthly Funding target. Underfunded.",
              });
              continue;
            }

            // P4: TB (target balance) or TBD (target balance by date) - savings goals
            if (
              (cat.goal_type === "TB" || cat.goal_type === "TBD") &&
              cat.goal_under_funded != null &&
              cat.goal_under_funded > 0
            ) {
              p4Savings.push({
                cat: info,
                needed: cat.goal_under_funded,
                reason:
                  cat.goal_type === "TBD"
                    ? `Savings target (by ${cat.goal_target_date ?? "date"}). Underfunded.`
                    : "Target balance goal. Underfunded.",
              });
              continue;
            }

            // P3: Variable spending categories where historical avg > current balance
            // (no target or target already met, but historically needs more)
            const histAvg = historicalAvg.get(cat.id);
            if (histAvg && histAvg > 0) {
              const gap = histAvg - Math.max(0, cat.balance);
              if (gap > 0) {
                p3Variable.push({
                  cat: info,
                  needed: gap,
                  reason: `Historical avg spending (${formatCurrency(histAvg, cf)}) exceeds current balance. Gap needs funding.`,
                });
              }
            }
          }
        }

        // Allocate in priority order
        let remaining = availableMilliunits;
        const allocations: AllocationEntry[] = [];

        const allocateBucket = (
          bucket: Array<{ cat: CategoryInfo; needed: number; reason: string }>,
          priority: AllocationEntry["priority"],
        ) => {
          // Sort by needed amount ascending (fund smallest first to maximize coverage)
          const sorted = [...bucket].sort((a, b) => a.needed - b.needed);
          for (const item of sorted) {
            if (remaining <= 0) break;
            const amount = Math.min(item.needed, remaining);
            remaining -= amount;
            allocations.push({
              category_id: item.cat.id,
              category_name: item.cat.name,
              group_name: item.cat.group_name,
              priority,
              amount: milliunitsToCurrency(amount),
              amount_display: formatCurrency(amount, cf),
              reason: item.reason,
            });
          }
        };

        allocateBucket(p1Bills, "P1_bills_due");
        allocateBucket(p2Monthly, "P2_monthly_contribution");
        allocateBucket(p3Variable, "P3_variable_spending");

        // P4 savings: prorate if insufficient
        if (remaining > 0 && p4Savings.length > 0) {
          const totalSavingsNeeded = p4Savings.reduce(
            (sum, item) => sum + item.needed,
            0,
          );
          if (remaining >= totalSavingsNeeded) {
            allocateBucket(p4Savings, "P4_savings");
          } else {
            // Prorate
            for (const item of p4Savings) {
              if (remaining <= 0) break;
              const proportion = item.needed / totalSavingsNeeded;
              const amount = Math.min(
                Math.round(remaining * proportion),
                item.needed,
              );
              if (amount > 0) {
                allocations.push({
                  category_id: item.cat.id,
                  category_name: item.cat.name,
                  group_name: item.cat.group_name,
                  priority: "P4_savings",
                  amount: milliunitsToCurrency(amount),
                  amount_display: formatCurrency(amount, cf),
                  reason: `${item.reason} (prorated — not enough to fully fund all savings)`,
                });
              }
            }
            remaining = 0;
          }
        }

        // Build set_budget_actions
        const setBudgetActions: Array<{
          category_id: string;
          month: string;
          budgeted: number;
        }> = [];

        // Group allocations by category (in case of duplicates)
        const allocationByCategory = new Map<string, number>();
        for (const alloc of allocations) {
          const current = allocationByCategory.get(alloc.category_id) ?? 0;
          allocationByCategory.set(
            alloc.category_id,
            current + currencyToMilliunits(alloc.amount),
          );
        }

        // Find current budgeted amounts to compute new totals
        for (const [catId, addMilliunits] of allocationByCategory) {
          let currentBudgeted = 0;
          for (const group of categoryGroups) {
            for (const cat of group.categories) {
              if (cat.id === catId) {
                currentBudgeted = cat.budgeted;
                break;
              }
            }
          }
          setBudgetActions.push({
            category_id: catId,
            month,
            budgeted: milliunitsToCurrency(currentBudgeted + addMilliunits),
          });
        }

        const totalAllocated = availableMilliunits - remaining;

        return jsonToolResult({
          budget_id: context.ynabClient.resolveBudgetId(input.budget_id),
          month,
          available_amount: milliunitsToCurrency(availableMilliunits),
          available_amount_display: formatCurrency(availableMilliunits, cf),
          total_allocated: milliunitsToCurrency(totalAllocated),
          total_allocated_display: formatCurrency(totalAllocated, cf),
          unallocated_remainder: milliunitsToCurrency(remaining),
          unallocated_remainder_display: formatCurrency(remaining, cf),
          allocation_count: allocations.length,
          allocations,
          set_budget_actions: setBudgetActions,
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(
            error,
            "Failed to compute budget allocation suggestions.",
          ),
        );
      }
    },
  );
}

// --- Helpers ---

interface CategoryInfo {
  id: string;
  name: string;
  group_name: string;
  budgeted: number;
  balance: number;
  activity: number;
  goal_type: string | null;
  goal_target: number | null;
  goal_under_funded: number | null;
  goal_target_date: string | null;
}

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
