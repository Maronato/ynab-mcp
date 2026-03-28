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

const CREDIT_CARD_PAYMENTS_GROUP = "Credit Card Payments";

const budgetHealthSchema = z.object({
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

interface Issue {
  severity: "critical" | "warning" | "info";
  message: string;
}

export function registerHealthTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "get_budget_health",
    {
      title: "Get Budget Health",
      description:
        "Single-call budget diagnostic. Surfaces overspending (cash vs credit), " +
        "underfunded targets, credit card payment gaps, uncategorized/unapproved " +
        "transaction counts, and Ready to Assign status with severity-rated issues.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: budgetHealthSchema,
    },
    async (input) => {
      try {
        const month = input.month ?? getCurrentMonth();

        const [monthSummary, accounts, categoryGroups, settings] =
          await Promise.all([
            context.ynabClient.getMonthSummary(input.budget_id, month),
            context.ynabClient.getAccounts(input.budget_id, {
              includeClosed: false,
            }),
            context.ynabClient.getCategories(input.budget_id, { month }),
            context.ynabClient.getBudgetSettings(input.budget_id),
          ]);

        const cf = settings.currency_format;

        // --- Ready to Assign ---
        const rta = monthSummary.to_be_budgeted;
        let rtaStatus: "positive" | "zero" | "negative";
        if (rta > 0) rtaStatus = "positive";
        else if (rta < 0) rtaStatus = "negative";
        else rtaStatus = "zero";

        // --- Build account lookup for credit card gap detection ---
        const creditCardAccounts = accounts.filter(
          (a) => a.type === "creditCard",
        );

        // --- Build credit card payment category lookup ---
        // YNAB puts one category per credit card in the "Credit Card Payments" group.
        // The category name matches the account name.
        const paymentCategoryByName = new Map<
          string,
          { id: string; balance: number }
        >();
        for (const group of categoryGroups) {
          if (group.name === CREDIT_CARD_PAYMENTS_GROUP) {
            for (const cat of group.categories) {
              if (!cat.hidden && !cat.deleted) {
                paymentCategoryByName.set(cat.name, {
                  id: cat.id,
                  balance: cat.balance,
                });
              }
            }
          }
        }

        // --- Overspending & underfunded ---
        const overspentCategories: Array<{
          id: string;
          name: string;
          group_name: string;
          balance: number;
          balance_display: string;
          type: "cash" | "credit";
        }> = [];
        const underfundedCategories: Array<{
          id: string;
          name: string;
          group_name: string;
          underfunded: number;
          underfunded_display: string;
          target_type: string | null;
        }> = [];

        let totalCashOverspend = 0;
        let totalCreditOverspend = 0;
        let totalUnderfunded = 0;
        let uncategorizedCount = 0;
        let unapprovedCount = 0;

        // Determine which category IDs belong to credit card payment categories
        const creditCardPaymentCategoryIds = new Set<string>();
        for (const group of categoryGroups) {
          if (group.name === CREDIT_CARD_PAYMENTS_GROUP) {
            for (const cat of group.categories) {
              creditCardPaymentCategoryIds.add(cat.id);
            }
          }
        }

        // Build a set of credit card account IDs for determining cash vs credit overspend
        const creditCardAccountIds = new Set(
          creditCardAccounts.map((a) => a.id),
        );

        for (const group of categoryGroups) {
          if (INTERNAL_GROUP_NAMES.has(group.name)) continue;

          for (const cat of group.categories) {
            if (cat.hidden || cat.deleted) continue;

            // Overspent detection
            if (cat.balance < 0) {
              // In YNAB, overspending on a credit card category is "credit overspending"
              // (deferred to debt), while overspending on cash categories is immediate.
              // We approximate: if category activity comes from credit card accounts,
              // it's credit overspending. Since we can't check per-transaction here,
              // we use a simpler heuristic: if the category has no budgeted amount and
              // the balance equals the activity, spending was likely all on credit.
              // However, the most reliable signal is checking if the balance is negative
              // and whether it represents cash vs credit. YNAB handles this internally.
              // For this diagnostic we mark overspending as "credit" if the negative
              // balance would be absorbed by a credit card payment category.
              // A practical approach: check if any credit card payment category also
              // has a reduced balance. For simplicity, we'll report all overspending
              // and let the credit card gap analysis handle the credit distinction.
              const isCreditOverspend = false; // Will be refined below
              overspentCategories.push({
                id: cat.id,
                name: cat.name,
                group_name: group.name,
                balance: milliunitsToCurrency(cat.balance),
                balance_display: formatCurrency(cat.balance, cf),
                type: isCreditOverspend ? "credit" : "cash",
              });
              totalCashOverspend += Math.abs(cat.balance);
            }

            // Underfunded detection
            if (
              cat.goal_under_funded !== null &&
              cat.goal_under_funded !== undefined &&
              cat.goal_under_funded > 0
            ) {
              underfundedCategories.push({
                id: cat.id,
                name: cat.name,
                group_name: group.name,
                underfunded: milliunitsToCurrency(cat.goal_under_funded),
                underfunded_display: formatCurrency(cat.goal_under_funded, cf),
                target_type: cat.goal_type ?? null,
              });
              totalUnderfunded += cat.goal_under_funded;
            }
          }
        }

        // Refine cash vs credit overspend classification.
        // YNAB shows credit overspending when spending in a category came through
        // a credit card. Since we have account data, we check: if ANY credit card
        // account's absolute balance exceeds its payment category balance, then
        // there's credit overspending happening. We mark individual overspent
        // categories as "credit" if the spending was likely on credit cards.
        // The simplest reliable approach: YNAB's month data doesn't tell us which
        // account the spending came from per-category. We'll mark ALL overspending
        // as cash (the conservative/actionable interpretation) unless we can detect
        // credit overspending from the credit card gap analysis.
        // Actually, let's use a better heuristic: if there are credit card gaps,
        // there's credit overspending happening somewhere.
        const creditCardGaps: Array<{
          account_id: string;
          account_name: string;
          account_balance: number;
          account_balance_display: string;
          payment_available: number;
          payment_available_display: string;
          gap: number;
          gap_display: string;
        }> = [];

        for (const account of creditCardAccounts) {
          const paymentCat = paymentCategoryByName.get(account.name);
          if (!paymentCat) continue;

          const owed = Math.abs(account.balance);
          const available = paymentCat.balance;
          const gap = owed - available;

          if (gap > 0) {
            creditCardGaps.push({
              account_id: account.id,
              account_name: account.name,
              account_balance: milliunitsToCurrency(account.balance),
              account_balance_display: formatCurrency(account.balance, cf),
              payment_available: milliunitsToCurrency(available),
              payment_available_display: formatCurrency(available, cf),
              gap: milliunitsToCurrency(gap),
              gap_display: formatCurrency(gap, cf),
            });
          }
        }

        // If there are credit card gaps, re-classify some overspending as credit
        if (creditCardGaps.length > 0) {
          let creditOverspendPool = creditCardGaps.reduce(
            (sum, g) => sum + Math.round(g.gap * 1000),
            0,
          );
          for (const cat of overspentCategories) {
            if (creditOverspendPool <= 0) break;
            const absBalance = Math.round(Math.abs(cat.balance) * 1000);
            const creditPortion = Math.min(absBalance, creditOverspendPool);
            if (creditPortion === absBalance) {
              cat.type = "credit";
              totalCashOverspend -= absBalance;
              totalCreditOverspend += absBalance;
            }
            creditOverspendPool -= creditPortion;
          }
        }

        // --- Count uncategorized and unapproved ---
        // Use searchTransactions to count these efficiently
        const sinceDate = month; // Start of month
        const endOfMonth = getEndOfMonth(month);

        const [uncategorized, unapproved] = await Promise.all([
          context.ynabClient.searchTransactions(input.budget_id, {
            type: "uncategorized",
            since_date: sinceDate,
            until_date: endOfMonth,
          }),
          context.ynabClient.searchTransactions(input.budget_id, {
            approved: false,
            since_date: sinceDate,
            until_date: endOfMonth,
          }),
        ]);

        uncategorizedCount = uncategorized.length;
        unapprovedCount = unapproved.length;

        // --- Build issues array ---
        const issues: Issue[] = [];

        if (rta < 0) {
          issues.push({
            severity: "critical",
            message: `Ready to Assign is negative (${formatCurrency(rta, cf)}). You have assigned more than you have available.`,
          });
        }

        if (totalCashOverspend > 0) {
          issues.push({
            severity: "critical",
            message: `Cash overspending of ${formatCurrency(totalCashOverspend, cf)} across ${overspentCategories.filter((c) => c.type === "cash").length} category(ies). This reduces Ready to Assign next month.`,
          });
        }

        if (totalCreditOverspend > 0) {
          issues.push({
            severity: "warning",
            message: `Credit overspending of ${formatCurrency(totalCreditOverspend, cf)} detected. This creates unbudgeted debt on your credit card(s).`,
          });
        }

        for (const gap of creditCardGaps) {
          issues.push({
            severity: "warning",
            message: `Credit card "${gap.account_name}" payment gap: owed ${gap.account_balance_display} but only ${gap.payment_available_display} available (gap: ${gap.gap_display}).`,
          });
        }

        if (totalUnderfunded > 0) {
          issues.push({
            severity: "warning",
            message: `${underfundedCategories.length} target(s) underfunded by a total of ${formatCurrency(totalUnderfunded, cf)}.`,
          });
        }

        if (uncategorizedCount > 0) {
          issues.push({
            severity: "warning",
            message: `${uncategorizedCount} uncategorized transaction(s) this month.`,
          });
        }

        if (unapprovedCount > 0) {
          issues.push({
            severity: "info",
            message: `${unapprovedCount} unapproved transaction(s) this month.`,
          });
        }

        if (rta > 0) {
          issues.push({
            severity: "info",
            message: `${formatCurrency(rta, cf)} is Ready to Assign. Consider allocating to underfunded targets or priorities.`,
          });
        }

        if (issues.length === 0) {
          issues.push({
            severity: "info",
            message:
              "Budget looks healthy. All categories funded, no overspending detected.",
          });
        }

        // Sort underfunded by amount descending for top list
        underfundedCategories.sort((a, b) => b.underfunded - a.underfunded);

        return jsonToolResult({
          budget_id: context.ynabClient.resolveBudgetId(input.budget_id),
          month,
          ready_to_assign: {
            amount: milliunitsToCurrency(rta),
            display: formatCurrency(rta, cf),
            status: rtaStatus,
          },
          overspending: {
            total_cash: milliunitsToCurrency(totalCashOverspend),
            total_cash_display: formatCurrency(totalCashOverspend, cf),
            total_credit: milliunitsToCurrency(totalCreditOverspend),
            total_credit_display: formatCurrency(totalCreditOverspend, cf),
            categories: overspentCategories,
          },
          underfunded_targets: {
            total: milliunitsToCurrency(totalUnderfunded),
            total_display: formatCurrency(totalUnderfunded, cf),
            count: underfundedCategories.length,
            top_underfunded: underfundedCategories.slice(0, 10),
          },
          credit_card_gaps: creditCardGaps,
          uncategorized_count: uncategorizedCount,
          unapproved_count: unapprovedCount,
          age_of_money: monthSummary.age_of_money ?? null,
          issues,
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to compute budget health."),
        );
      }
    },
  );
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
