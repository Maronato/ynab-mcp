import {
  type McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppContext } from "../context.js";
import { getKnowledgeTopics } from "../methodology/index.js";
import { textResource } from "../shared/mcp.js";
import { formatCurrency, milliunitsToCurrency } from "../ynab/format.js";

export function registerResources(
  server: McpServer,
  context: AppContext,
): void {
  server.registerResource(
    "budgets",
    "ynab://budgets",
    {
      title: "YNAB Budgets",
      description: "All available budgets.",
      mimeType: "application/json",
    },
    async (uri) => {
      const budgets = await context.ynabClient.listBudgets();
      return textResource(uri.toString(), {
        budgets: budgets.map((budget) => ({
          id: budget.id,
          name: budget.name,
          last_modified_on: budget.last_modified_on ?? null,
          first_month: budget.first_month ?? null,
          last_month: budget.last_month ?? null,
        })),
      });
    },
  );

  server.registerResource(
    "budget-settings",
    new ResourceTemplate("ynab://budgets/{budget_id}/settings", {
      list: undefined,
      complete: {
        budget_id: async (value) => getBudgetIdSuggestions(context, value),
      },
    }),
    {
      title: "Budget Settings",
      description: "Date and currency settings for a specific budget.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const budgetId = asBudgetId(variables.budget_id);
      const settings = await context.ynabClient.getBudgetSettings(budgetId);
      return textResource(uri.toString(), {
        budget_id: context.ynabClient.resolveBudgetId(budgetId),
        settings,
      });
    },
  );

  server.registerResource(
    "budget-payees",
    new ResourceTemplate("ynab://budgets/{budget_id}/payees", {
      list: undefined,
      complete: {
        budget_id: async (value) => getBudgetIdSuggestions(context, value),
      },
    }),
    {
      title: "Budget Payees",
      description: "Payee directory for a specific budget.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const budgetId = asBudgetId(variables.budget_id);
      const payees = await context.ynabClient.getPayees(budgetId);
      return textResource(uri.toString(), {
        budget_id: context.ynabClient.resolveBudgetId(budgetId),
        payees: payees.map((payee) => ({
          id: payee.id,
          name: payee.name,
          transfer_account_id: payee.transfer_account_id ?? null,
        })),
      });
    },
  );

  server.registerResource(
    "budget-category-groups",
    new ResourceTemplate("ynab://budgets/{budget_id}/category-groups", {
      list: undefined,
      complete: {
        budget_id: async (value) => getBudgetIdSuggestions(context, value),
      },
    }),
    {
      title: "Budget Category Groups",
      description:
        "Category hierarchy for a specific budget (groups and categories only).",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const budgetId = asBudgetId(variables.budget_id);
      const groups = await context.ynabClient.getCategories(budgetId, {
        includeHidden: true,
      });

      return textResource(uri.toString(), {
        budget_id: context.ynabClient.resolveBudgetId(budgetId),
        groups: groups.map((group) => ({
          id: group.id,
          name: group.name,
          hidden: group.hidden,
          categories: group.categories.map((category) => ({
            id: category.id,
            name: category.name,
            hidden: category.hidden,
            category_group_id: category.category_group_id,
          })),
        })),
      });
    },
  );

  server.registerResource(
    "budget-accounts",
    new ResourceTemplate("ynab://budgets/{budget_id}/accounts", {
      list: undefined,
      complete: {
        budget_id: async (value) => getBudgetIdSuggestions(context, value),
      },
    }),
    {
      title: "Budget Accounts",
      description: "Accounts and balances for a specific budget.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const budgetId = asBudgetId(variables.budget_id);
      const [accounts, settings] = await Promise.all([
        context.ynabClient.getAccounts(budgetId, { includeClosed: true }),
        context.ynabClient.getBudgetSettings(budgetId),
      ]);

      return textResource(uri.toString(), {
        budget_id: context.ynabClient.resolveBudgetId(budgetId),
        accounts: accounts.map((account) => ({
          id: account.id,
          name: account.name,
          type: account.type,
          on_budget: account.on_budget,
          closed: account.closed,
          balance_milliunits: account.balance,
          balance: milliunitsToCurrency(account.balance),
          balance_display: formatCurrency(
            account.balance,
            settings.currency_format,
          ),
        })),
      });
    },
  );

  registerKnowledgeResources(server);
}

function registerKnowledgeResources(server: McpServer): void {
  for (const topic of getKnowledgeTopics()) {
    server.registerResource(
      `knowledge-${topic.name}`,
      `ynab://knowledge/${topic.name}`,
      {
        title: topic.title,
        description: topic.description,
        mimeType: "text/markdown",
      },
      (uri) => ({
        contents: [
          {
            uri: uri.toString(),
            mimeType: "text/markdown",
            text: topic.content,
          },
        ],
      }),
    );
  }
}

async function getBudgetIdSuggestions(
  context: AppContext,
  value: string,
): Promise<string[]> {
  const normalized = value.toLowerCase();
  const budgets = await context.ynabClient.listBudgets();

  const suggestions = budgets
    .filter(
      (budget) =>
        budget.id.toLowerCase().includes(normalized) ||
        budget.name.toLowerCase().includes(normalized),
    )
    .slice(0, 20)
    .map((budget) => budget.id);

  if ("last-used".includes(normalized)) {
    suggestions.unshift("last-used");
  }

  return [...new Set(suggestions)];
}

function asBudgetId(variable: unknown): string {
  if (typeof variable === "string" && variable.length > 0) {
    return variable;
  }

  return "last-used";
}
