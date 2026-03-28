import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { extractErrorMessage } from "../ynab/errors.js";
import {
  asMilliunits,
  formatCurrency,
  milliunitsToCurrency,
} from "../ynab/format.js";

const diagnoseCreditCardDebtSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe("Budget ID. Omit to use the last-used budget."),
  lookback_months: z
    .number()
    .int()
    .min(1)
    .max(24)
    .default(3)
    .describe("How many months to scan for overspending sources."),
});

interface DebtSource {
  month: string;
  category_name: string;
  overspent_amount: number;
  overspent_display: string;
}

interface CardDiagnosis {
  account_id: string;
  account_name: string;
  card_balance: number;
  card_balance_display: string;
  payment_available: number;
  payment_available_display: string;
  gap: number;
  gap_display: string;
  has_debt: boolean;
  debt_sources: DebtSource[];
}

function getMonthStrings(count: number): string[] {
  const months: string[] = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.toISOString().slice(0, 10));
  }
  return months;
}

export function registerCreditDiagnosisTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "diagnose_credit_card_debt",
    {
      title: "Diagnose Credit Card Debt",
      description:
        "Trace credit card debt to its source by comparing each card's balance " +
        "against its payment category's available amount. When a gap exists, " +
        "scans recent months for category overspending that contributed to the debt. " +
        "Returns set_budget_actions to suggest extra payment allocation (suggestions only).",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: diagnoseCreditCardDebtSchema,
    },
    async (input) => {
      try {
        const resolvedBudgetId = await context.ynabClient.resolveRealBudgetId(
          input.budget_id,
        );
        const lookbackMonths = input.lookback_months;

        const [accounts, categoryGroups, settings] = await Promise.all([
          context.ynabClient.getAccounts(resolvedBudgetId, {
            includeClosed: false,
          }),
          context.ynabClient.getCategories(resolvedBudgetId, {
            includeHidden: true,
          }),
          context.ynabClient.getBudgetSettings(resolvedBudgetId),
        ]);

        const currencyFormat = settings.currency_format;

        // Find credit card accounts
        const creditCards = accounts.filter((a) => a.type === "creditCard");

        if (creditCards.length === 0) {
          return jsonToolResult({
            budget_id: resolvedBudgetId,
            cards: [],
            total_debt: 0,
            total_debt_display: formatCurrency(asMilliunits(0), currencyFormat),
            set_budget_actions: [],
            message: "No credit card accounts found.",
          });
        }

        // Find the "Credit Card Payments" category group and build a map from
        // category name to category id.  YNAB names payment categories after
        // the credit card account, so we also build an account-name-to-category
        // mapping.
        const paymentCategoryByAccountName = new Map<
          string,
          { id: string; name: string; balance: number }
        >();
        const paymentCategoryById = new Map<
          string,
          { id: string; name: string; balance: number }
        >();

        for (const group of categoryGroups) {
          if (group.name === "Credit Card Payments") {
            for (const cat of group.categories) {
              paymentCategoryByAccountName.set(cat.name, {
                id: cat.id,
                name: cat.name,
                balance: cat.balance,
              });
              paymentCategoryById.set(cat.id, {
                id: cat.id,
                name: cat.name,
                balance: cat.balance,
              });
            }
          }
        }

        const months = getMonthStrings(lookbackMonths);
        const cards: CardDiagnosis[] = [];
        const setBudgetActions: Array<{
          category_id: string;
          month: string;
          budgeted: number;
        }> = [];
        let totalDebtMilliunits = 0;

        for (const card of creditCards) {
          const cardBalance = card.balance; // Negative for owed amounts
          const absCardBalance = Math.abs(cardBalance);

          // Find the payment category for this card (matched by account name)
          const paymentCat = paymentCategoryByAccountName.get(card.name);
          const paymentAvailable = paymentCat?.balance ?? 0;

          // Gap = how much more is owed than is available to pay
          const gap =
            absCardBalance > paymentAvailable
              ? absCardBalance - paymentAvailable
              : 0;
          const hasDebt = gap > 0;

          if (hasDebt) {
            totalDebtMilliunits += gap;
          }

          // Scan recent months for overspending sources on this card
          const debtSources: DebtSource[] = [];

          if (hasDebt) {
            // Fetch all lookback months in parallel
            const monthResults = await Promise.all(
              months.map((month) =>
                context.ynabClient
                  .getMonthSummary(resolvedBudgetId, month)
                  .then((detail) => ({ month, detail }))
                  .catch(() => null),
              ),
            );

            for (const result of monthResults) {
              if (!result) continue;
              const { month, detail } = result;

              // Check each category in this month for negative balance (overspending)
              for (const cat of detail.categories) {
                if (cat.deleted || cat.hidden) continue;
                // Skip the credit card payment categories themselves
                if (paymentCategoryById.has(cat.id)) continue;

                if (cat.balance < 0) {
                  // This category was overspent in this month
                  const overspent = Math.abs(cat.balance);
                  debtSources.push({
                    month,
                    category_name: cat.name,
                    overspent_amount: milliunitsToCurrency(
                      asMilliunits(overspent),
                    ),
                    overspent_display: formatCurrency(
                      asMilliunits(overspent),
                      currencyFormat,
                    ),
                  });
                }
              }
            }

            // Sort debt sources by overspent amount descending
            debtSources.sort((a, b) => b.overspent_amount - a.overspent_amount);

            // Suggest budget action: allocate extra to the payment category
            if (paymentCat) {
              const currentMonth = months[0]; // Current month
              setBudgetActions.push({
                category_id: paymentCat.id,
                month: currentMonth,
                budgeted: milliunitsToCurrency(asMilliunits(gap)),
              });
            }
          }

          cards.push({
            account_id: card.id,
            account_name: card.name,
            card_balance: milliunitsToCurrency(asMilliunits(cardBalance)),
            card_balance_display: formatCurrency(
              asMilliunits(cardBalance),
              currencyFormat,
            ),
            payment_available: milliunitsToCurrency(
              asMilliunits(paymentAvailable),
            ),
            payment_available_display: formatCurrency(
              asMilliunits(paymentAvailable),
              currencyFormat,
            ),
            gap: milliunitsToCurrency(asMilliunits(gap)),
            gap_display: formatCurrency(asMilliunits(gap), currencyFormat),
            has_debt: hasDebt,
            debt_sources: debtSources,
          });
        }

        return jsonToolResult({
          budget_id: resolvedBudgetId,
          cards,
          total_debt: milliunitsToCurrency(asMilliunits(totalDebtMilliunits)),
          total_debt_display: formatCurrency(
            asMilliunits(totalDebtMilliunits),
            currencyFormat,
          ),
          set_budget_actions: setBudgetActions,
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to diagnose credit card debt."),
        );
      }
    },
  );
}
