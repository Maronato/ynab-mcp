import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { promptResult } from "../shared/mcp.js";

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "monthly-review",
    {
      title: "Monthly Review",
      description: "Run a structured monthly YNAB review workflow.",
      argsSchema: {
        budget_id: z.string().optional(),
        month: z.string().optional(),
      },
    },
    ({ budget_id: budgetId, month }) => {
      const monthValue = month ?? "current";
      const budgetValue = budgetId ?? "last-used";

      return promptResult(
        "Monthly review workflow",
        [
          "Run a focused monthly budget review using the MCP tools below.",
          "",
          `Budget: ${budgetValue}`,
          `Month: ${monthValue}`,
          "",
          "Before giving advice, read these knowledge resources for accurate YNAB methodology:",
          "- `ynab://knowledge/terminology` — Core concepts and terms",
          "- `ynab://knowledge/overspending` — Cash vs credit overspending rules",
          "- `ynab://knowledge/credit-cards` — Credit card payment mechanics",
          "- `ynab://knowledge/targets` — Target types and underfunded calculations",
          "",
          "1) Call `get_budget_health` for overall status — overspending, target progress, RTA, and credit card gaps.",
          "2) If mid-month, call `get_spending_velocity` to check spending pace per category.",
          "3) Call `forecast_category_balances` to predict end-of-month balances.",
          "4) If overspending is found, call `suggest_overspending_coverage` for reallocation options.",
          "5) If RTA > 0, call `suggest_budget_allocation` to assign unbudgeted funds by priority.",
          "6) Call `detect_anomalies` to flag unusual transactions that may need review.",
          "7) Suggest concrete actions (reassign budget, recategorize, adjust scheduled transactions).",
        ].join("\n"),
      );
    },
  );

  server.registerPrompt(
    "spending-report",
    {
      title: "Spending Report",
      description: "Generate a spending report for a date range.",
      argsSchema: {
        budget_id: z.string().optional(),
        since_date: z.string(),
        until_date: z.string().optional(),
      },
    },
    ({ budget_id: budgetId, since_date: sinceDate, until_date: untilDate }) =>
      promptResult(
        "Spending report workflow",
        [
          "Build a spending report for the provided period.",
          "",
          `Budget: ${budgetId ?? "last-used"}`,
          `From: ${sinceDate}`,
          `To: ${untilDate ?? "today"}`,
          "",
          "Before giving advice, read these knowledge resources for accurate YNAB methodology:",
          "- `ynab://knowledge/terminology` — Core concepts and terms",
          "- `ynab://knowledge/credit-cards` — Credit card payment mechanics",
          "",
          "1) Call `get_spending_trends` covering the date range for multi-month category and payee trends.",
          "2) Call `get_income_expense_summary` for income vs expense totals and savings rate.",
          "3) Call `get_spending_breakdown` for behavioral patterns (daily, weekly, or day-of-week granularity).",
          "4) Call `detect_recurring_charges` for a subscription overview and recurring cost summary.",
          "5) Highlight unusual patterns, top spending categories, and actionable recommendations.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "triage-unapproved",
    {
      title: "Triage Unapproved Transactions",
      description:
        "Review and batch-handle unapproved transactions efficiently.",
      argsSchema: {
        budget_id: z.string().optional(),
      },
    },
    ({ budget_id: budgetId }) =>
      promptResult(
        "Unapproved transaction triage workflow",
        [
          "Triage unapproved transactions with minimal tool calls.",
          "",
          `Budget: ${budgetId ?? "last-used"}`,
          "",
          "Before giving advice, read these knowledge resources for accurate YNAB methodology:",
          "- `ynab://knowledge/terminology` — Core concepts and transaction states",
          "- `ynab://knowledge/reconciliation` — Transaction status lifecycle",
          "",
          '1) Call `search_transactions` with one query: `{ "type": "unapproved", "sort": "date_asc", "limit": 500 }`.',
          "2) Call `suggest_transaction_categories` to get batch categorization suggestions for uncategorized items.",
          "3) Call `detect_anomalies` to flag suspicious or unusual transactions in the set.",
          "4) Present transactions in a compact table: date, payee, amount, category, memo. Mark anomalies and category suggestions.",
          "5) Ask for decisions in batch (approve only, approve+recategorize, edit memo, delete).",
          "6) Build one `update_transactions` request with all approval/edits and one `delete_transactions` request for deletions.",
          "7) Execute updates and deletions, then report `undo_history_ids` so changes can be quickly reverted if needed.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "budget-optimization",
    {
      title: "Budget Optimization",
      description: "Analyze your budget for optimization opportunities.",
      argsSchema: {
        budget_id: z.string().optional(),
      },
    },
    ({ budget_id: budgetId }) =>
      promptResult(
        "Budget optimization workflow",
        [
          "Analyze the budget and suggest optimizations.",
          "",
          `Budget: ${budgetId ?? "last-used"}`,
          "",
          "Before giving advice, read these knowledge resources for accurate YNAB methodology:",
          "- `ynab://knowledge/terminology` — Core concepts and terms",
          "- `ynab://knowledge/targets` — Target types and underfunded calculations",
          "- `ynab://knowledge/credit-cards` — Credit card payment mechanics",
          "",
          "1) Call `get_budget_health` for current budget state — overspending, target gaps, RTA, credit card issues.",
          "2) Call `get_spending_trends` to identify patterns and categories trending up or down.",
          "3) Call `detect_recurring_charges` to audit subscriptions and find potential savings.",
          "4) Call `suggest_budget_allocation` to model a better allocation based on priorities.",
          "5) If credit card accounts are present, call `diagnose_credit_card_debt` to trace debt sources and suggest payoff strategies.",
          "6) Present findings with specific, actionable recommendations ranked by impact.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "subscription-audit",
    {
      title: "Subscription Audit",
      description: "Review recurring charges and manage subscriptions.",
      argsSchema: {
        budget_id: z.string().optional(),
      },
    },
    ({ budget_id: budgetId }) =>
      promptResult(
        "Subscription audit workflow",
        [
          "Audit recurring charges and subscription management.",
          "",
          `Budget: ${budgetId ?? "last-used"}`,
          "",
          "Before giving advice, read these knowledge resources for accurate YNAB methodology:",
          "- `ynab://knowledge/terminology` — Core concepts and terms",
          "",
          "1) Call `detect_recurring_charges` to get a full inventory of detected subscriptions.",
          "2) Flag any price changes (amounts that have increased since first detected).",
          "3) Flag overdue charges (subscriptions where the next expected charge is past due).",
          "4) Present a clear table: payee, amount, frequency, category, last charge date, and any flags.",
          "5) For recurring charges not backed by scheduled transactions, suggest creating them using the `create_scheduled_actions` from the detection results.",
          "6) Summarize total monthly subscription cost and highlight candidates for cancellation or renegotiation.",
        ].join("\n"),
      ),
  );
}
