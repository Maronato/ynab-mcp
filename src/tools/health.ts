import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import {
  isCreditCardPaymentsGroup,
  isSystemCategoryGroup,
} from "../shared/categories.js";
import { currentMonthString, endOfMonthString } from "../shared/dates.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { extractErrorMessage } from "../ynab/errors.js";
import {
  asCurrency,
  asMilliunits,
  currencyToMilliunits,
  formatCurrency,
  milliunitsToCurrency,
} from "../ynab/format.js";

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
        "Single-call budget snapshot and diagnostic. Surfaces net worth, account " +
        "totals by type, month totals, overspent categories, underfunded targets, " +
        "credit card payment gaps, uncategorized/unapproved transaction counts, and " +
        "Ready to Assign status with severity-rated issues. Note: the YNAB API does " +
        "not expose whether overspending happened on cash or credit; judge that from " +
        "the credit card payment gaps and the transactions themselves.",
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
        const month = input.month ?? currentMonthString();

        const [monthSummary, allAccounts, categoryGroups, settings] =
          await Promise.all([
            context.ynabClient.getMonthSummary(input.budget_id, month),
            context.ynabClient.getAccounts(input.budget_id, {
              includeClosed: true,
            }),
            context.ynabClient.getCategories(input.budget_id, { month }),
            context.ynabClient.getBudgetSettings(input.budget_id),
          ]);

        const cf = settings.currency_format;

        // --- Net worth and account totals (all accounts, including closed) ---
        const netWorth = allAccounts.reduce((sum, a) => sum + a.balance, 0);
        const accountsByType = new Map<
          string,
          { type: string; count: number; total_balance: number }
        >();
        for (const account of allAccounts) {
          const entry = accountsByType.get(account.type) ?? {
            type: account.type,
            count: 0,
            total_balance: 0,
          };
          entry.count += 1;
          entry.total_balance += account.balance;
          accountsByType.set(account.type, entry);
        }

        const openAccounts = allAccounts.filter((a) => !a.closed);

        // --- Ready to Assign ---
        const rta = monthSummary.to_be_budgeted;
        let rtaStatus: "positive" | "zero" | "negative";
        if (rta > 0) rtaStatus = "positive";
        else if (rta < 0) rtaStatus = "negative";
        else rtaStatus = "zero";

        // --- Build account lookup for credit card gap detection ---
        const creditCardAccounts = openAccounts.filter(
          (a) => a.type === "creditCard",
        );

        // --- Build credit card payment category lookup ---
        // YNAB puts one category per credit card in its payments group.
        // The category name matches the account name.
        const creditCardAccountNames = new Set(
          creditCardAccounts.map((a) => a.name),
        );
        const paymentCategoryByName = new Map<
          string,
          { id: string; balance: number }
        >();
        for (const group of categoryGroups) {
          if (isCreditCardPaymentsGroup(group, creditCardAccountNames)) {
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
        }> = [];
        const underfundedCategories: Array<{
          id: string;
          name: string;
          group_name: string;
          underfunded: number;
          target_type: string | null;
        }> = [];

        let totalOverspend = 0;
        let totalUnderfunded = 0;

        for (const group of categoryGroups) {
          if (isSystemCategoryGroup(group, creditCardAccountNames)) continue;

          for (const cat of group.categories) {
            if (cat.hidden || cat.deleted) continue;

            if (cat.balance < 0) {
              overspentCategories.push({
                id: cat.id,
                name: cat.name,
                group_name: group.name,
                balance: milliunitsToCurrency(asMilliunits(cat.balance)),
              });
              totalOverspend += Math.abs(cat.balance);
            }

            if (
              cat.goal_under_funded !== null &&
              cat.goal_under_funded !== undefined &&
              cat.goal_under_funded > 0
            ) {
              underfundedCategories.push({
                id: cat.id,
                name: cat.name,
                group_name: group.name,
                underfunded: milliunitsToCurrency(
                  asMilliunits(cat.goal_under_funded),
                ),
                target_type: cat.goal_type ?? null,
              });
              totalUnderfunded += cat.goal_under_funded;
            }
          }
        }

        // --- Credit card payment gaps (owed vs available to pay) ---
        const creditCardGaps: Array<{
          account_id: string;
          account_name: string;
          account_balance: number;
          payment_available: number;
          gap: number;
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
              account_balance: milliunitsToCurrency(
                asMilliunits(account.balance),
              ),
              payment_available: milliunitsToCurrency(asMilliunits(available)),
              gap: milliunitsToCurrency(asMilliunits(gap)),
            });
          }
        }

        // --- Count uncategorized and unapproved ---
        const sinceDate = month; // Start of month
        const endOfMonth = endOfMonthString(month);

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

        const uncategorizedCount = uncategorized.length;
        const unapprovedCount = unapproved.length;

        // --- Build issues array ---
        const issues: Issue[] = [];

        if (rta < 0) {
          issues.push({
            severity: "critical",
            message: `Ready to Assign is negative (${formatCurrency(asMilliunits(rta), cf)}). You have assigned more than you have available.`,
          });
        }

        if (totalOverspend > 0) {
          issues.push({
            severity: "critical",
            message:
              `Overspending of ${formatCurrency(asMilliunits(totalOverspend), cf)} across ${overspentCategories.length} category(ies). ` +
              "Cash overspending reduces next month's Ready to Assign; credit overspending becomes card debt unless the payment category is topped up.",
          });
        }

        for (const gap of creditCardGaps) {
          issues.push({
            severity: "warning",
            message:
              `Credit card "${gap.account_name}" payment gap: owed ` +
              `${formatCurrency(currencyToMilliunits(asCurrency(Math.abs(gap.account_balance))), cf)} but only ` +
              `${formatCurrency(currencyToMilliunits(asCurrency(gap.payment_available)), cf)} available (gap: ` +
              `${formatCurrency(currencyToMilliunits(asCurrency(gap.gap)), cf)}).`,
          });
        }

        if (totalUnderfunded > 0) {
          issues.push({
            severity: "warning",
            message: `${underfundedCategories.length} target(s) underfunded by a total of ${formatCurrency(asMilliunits(totalUnderfunded), cf)}.`,
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
            message: `${formatCurrency(asMilliunits(rta), cf)} is Ready to Assign. Consider allocating to underfunded targets or priorities.`,
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
          net_worth: {
            amount: milliunitsToCurrency(asMilliunits(netWorth)),
          },
          accounts_by_type: [...accountsByType.values()].map((entry) => ({
            type: entry.type,
            count: entry.count,
            total_balance: milliunitsToCurrency(
              asMilliunits(entry.total_balance),
            ),
          })),
          month_totals: {
            income: milliunitsToCurrency(asMilliunits(monthSummary.income)),
            budgeted: milliunitsToCurrency(asMilliunits(monthSummary.budgeted)),
            activity: milliunitsToCurrency(asMilliunits(monthSummary.activity)),
          },
          ready_to_assign: {
            amount: milliunitsToCurrency(asMilliunits(rta)),
            status: rtaStatus,
          },
          overspending: {
            total: milliunitsToCurrency(asMilliunits(totalOverspend)),
            count: overspentCategories.length,
            categories: overspentCategories,
          },
          underfunded_targets: {
            total: milliunitsToCurrency(asMilliunits(totalUnderfunded)),
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
