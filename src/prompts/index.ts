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
          "- `ynab://knowledge/goals` — Goal types and underfunded calculations",
          "",
          "1) Call `get_budget_summary` for high-level context.",
          `2) Call \`get_monthly_budget\` with month=${monthValue}.`,
          "3) Identify overspent categories and largest outflows.",
          "4) Call `search_transactions` for suspicious or large transactions that need categorization fixes.",
          "5) Suggest concrete actions (reassign budget, recategorize, adjust scheduled transactions).",
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
          '1) Call `get_spending_analysis` with `group_by: "both"`.',
          "2) Provide top categories and payees with percentages of total spending.",
          "3) Highlight unusual patterns and actionable recommendations.",
          "4) If needed, call `search_transactions` for deeper drill-down on specific category/payee groups.",
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
          "2) Present transactions in a compact table: date, payee, amount, category, memo.",
          "3) Ask for decisions in batch (approve only, approve+recategorize, edit memo, delete).",
          "4) Build one `update_transactions` request with all approval/edits and one `delete_transactions` request for deletions.",
          "5) Execute updates and deletions, then report `undo_history_ids` so changes can be quickly reverted if needed.",
        ].join("\n"),
      ),
  );
}
