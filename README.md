# YNAB MCP Server

An MCP server for YNAB with batch operations, deterministic analysis tools, and robust undo support.

> [!NOTE]
> **AI Disclosure:** This project was built with Claude Code and Cursor. It works and is tested, but the code is largely clanker-made.

## Highlights

- **32 tools** covering budgets, accounts, transactions, categories, targets, scheduled transactions, and spending analysis
- **Deterministic analysis** — budget health, spending trends, forecasts, anomaly detection, and more with no LLM sampling
- **Batch operations** — create, update, and delete multiple transactions or category assignments in a single call
- **Undo support** — every write operation is recorded and reversible
- **Smart tools** — transaction categorization, overspending coverage, and budget allocation suggestions using payee history and patterns
- **Built-in knowledge base** — YNAB methodology docs (credit cards, targets, overspending, reconciliation) served as MCP resources
- **5 workflow prompts** — monthly reviews, spending reports, unapproved triage, budget optimization, and subscription audits
- **Read-only mode** — disable all write operations for safe exploration
- **Efficient caching** — delta sync with YNAB's server knowledge system minimizes API calls

## Setup

### Prerequisites

- Node.js >= 20
- A YNAB [personal access token](https://app.ynab.com/settings/developer)

### Usage

Run directly with `npx`:

```bash
YNAB_API_TOKEN=your-token npx @maro-org/ynab-mcp
```

Or install globally:

```bash
npm install -g @maro-org/ynab-mcp
YNAB_API_TOKEN=your-token ynab-mcp
```

### MCP Client Configuration

Add the server to your MCP client config. For example, in Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ynab": {
      "command": "npx",
      "args": ["-y", "@maro-org/ynab-mcp"],
      "env": {
        "YNAB_API_TOKEN": "your-token"
      }
    }
  }
}
```

For Cursor, add the same structure to `.cursor/mcp.json` in your project or `~/.cursor/mcp.json` globally.

## Configuration

All configuration is done through environment variables.

| Variable            | Description                                           | Default       |
| ------------------- | ----------------------------------------------------- | ------------- |
| `YNAB_API_TOKEN`    | YNAB personal access token                            | **required**  |
| `YNAB_API_URL`      | Override the YNAB API base URL                        | YNAB default  |
| `YNAB_MCP_DATA_DIR` | Directory for undo history storage                    | `~/.ynab-mcp` |
| `YNAB_READ_ONLY`    | Disable all write operations (`true`/`false`/`1`/`0`) | `false`       |

## Tools

### Budgets

| Tool                 | Description                                                    |
| -------------------- | -------------------------------------------------------------- |
| `list_budgets`       | List all budgets with metadata                                 |
| `get_budget_summary` | Net worth, month totals, overspent categories, account summary |
| `sync_budget_data`   | Force-refresh cached data from YNAB                            |

### Accounts

| Tool           | Description                                                       |
| -------------- | ----------------------------------------------------------------- |
| `get_accounts` | List accounts with balances, filterable by type and on/off budget |

### Transactions

| Tool                  | Description                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `search_transactions` | Search with filters (dates, amounts, accounts, categories, payees, flags, cleared status) — supports multiple queries in one call |
| `create_transactions` | Batch create transactions with optional splits                                                                                    |
| `update_transactions` | Batch update existing transactions                                                                                                |
| `delete_transactions` | Batch delete transactions                                                                                                         |

### Categories

| Tool                   | Description                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `list_categories`      | Category group hierarchy with IDs and names                                          |
| `get_targets`          | Target details: type, amounts, underfunded, percent complete, cadence, and deadlines |
| `get_monthly_budget`   | Month-level budgeted/activity/balance per category                                   |
| `set_category_budgets` | Batch set budgeted amounts across categories and months                              |
| `set_category_targets` | Create or update category targets (monthly, weekly, by-date, etc.)                   |

### Spending Analysis

| Tool                    | Description                                                                  |
| ----------------------- | ---------------------------------------------------------------------------- |
| `get_spending_analysis` | Spending aggregates grouped by category, payee, or both — with top-N ranking |

### Scheduled Transactions

| Tool                            | Description                                                               |
| ------------------------------- | ------------------------------------------------------------------------- |
| `get_scheduled_transactions`    | List scheduled transactions with optional filters                         |
| `create_scheduled_transactions` | Batch create with frequency (daily, weekly, monthly, yearly, or one-time) |
| `update_scheduled_transactions` | Batch update scheduled transactions                                       |
| `delete_scheduled_transactions` | Batch delete scheduled transactions                                       |

### Smart Tools

| Tool                             | Description                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `suggest_transaction_categories` | Suggest categories for uncategorized transactions based on payee history and patterns |
| `suggest_overspending_coverage`  | Suggest budget moves to cover overspent categories from surplus ones                  |
| `suggest_budget_allocation`      | Priority-based allocation of unbudgeted funds across underfunded categories            |

These return structured actions that can be passed directly to `update_transactions` or `set_category_budgets`.

### Analysis & Diagnostics

| Tool                         | Description                                                          |
| ---------------------------- | -------------------------------------------------------------------- |
| `get_budget_health`          | Single-call budget diagnostic: overspending, target gaps, RTA, flags |
| `get_spending_velocity`      | Mid-month spending pace per category vs budget                       |
| `forecast_category_balances` | End-of-month balance projections based on scheduled and past trends  |
| `get_spending_trends`        | Multi-month time series by category or payee                         |
| `get_income_expense_summary` | Income vs expense totals with savings rate                           |
| `get_spending_breakdown`     | Spending by time granularity (daily, weekly, day-of-week)            |
| `detect_recurring_charges`   | Subscription and recurring charge detection from transaction history |
| `detect_anomalies`           | Flag unusual transactions by amount, frequency, or category          |
| `diagnose_credit_card_debt`  | Trace credit card debt sources and suggest payoff strategies         |

All analysis tools are deterministic -- no LLM sampling involved.

### Undo

| Tool                | Description                                      |
| ------------------- | ------------------------------------------------ |
| `list_undo_history` | List recorded undo entries                       |
| `undo_operations`   | Undo one or more previous write operations by ID |

## Resources

Knowledge base resources for YNAB methodology. Workflow prompts reference these automatically.

| URI                               | Topic                              |
| --------------------------------- | ---------------------------------- |
| `ynab://knowledge/terminology`    | Core YNAB concepts and terminology |
| `ynab://knowledge/credit-cards`   | Credit card handling               |
| `ynab://knowledge/targets`        | Target types and behavior          |
| `ynab://knowledge/overspending`   | Overspending mechanics             |
| `ynab://knowledge/reconciliation` | Reconciliation workflow            |
| `ynab://knowledge/api-quirks`     | API quirks and limitations         |

## Prompts

| Prompt                 | Description                                      |
| ---------------------- | ------------------------------------------------ |
| `monthly-review`       | Guided monthly budget review                     |
| `spending-report`      | Spending report for a date range                 |
| `triage-unapproved`    | Batch review and approve unapproved transactions |
| `budget-optimization`  | Analyze budget for optimization opportunities    |
| `subscription-audit`   | Review recurring charges and manage subscriptions |

## Key Concepts

**Currency units** — All monetary amounts in tool inputs and outputs use standard currency units (e.g., `12.50`), not YNAB's native milliunits. The server handles conversion automatically.

**`budget_id`** — Most tools accept an optional `budget_id`. Omit it or pass `"last-used"` to target the most recently accessed budget.

**Undo** — Every write operation records an undo entry. Use `list_undo_history` and `undo_operations` to review or revert changes.

**Read-only mode** — Set `YNAB_READ_ONLY=true` to block all write operations. Useful for exploring your budget safely or restricting an MCP client to read-only access.

## Development

```bash
npm install
npm run dev        # run with tsx watch
npm run build      # compile TypeScript
npm test           # run tests (vitest)
npm run typecheck  # type-check without emitting
npm run lint       # lint with Biome
npm run ci         # typecheck + lint + test
```

## License

[MIT](LICENSE)
