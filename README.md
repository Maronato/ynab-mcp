# YNAB MCP Server

An MCP server for YNAB with batch operations, deterministic analysis tools, and robust undo support.

> [!NOTE]
> **AI Disclosure:** This project was built with Claude Code and Cursor. It works and is tested, but the code is largely clanker-made.

## Highlights

- **26 tools** covering budgets, accounts, transactions, categories, targets, scheduled transactions, and spending analysis
- **Deterministic analysis** — spending aggregation, trends, income vs expense, recurring-charge and anomaly detection, and a one-call budget health snapshot. Judgment calls (forecasting, reallocation, prioritization) are deliberately left to the calling agent, which has the exact data and more context
- **Batch operations** — create, update, and delete multiple transactions in a single call, with per-item API costs documented where the YNAB API has no bulk endpoint
- **Undo support** — every write operation is recorded and reversible
- **Smart categorization** — transaction category suggestions from payee history and scheduled-transaction matching, with confidence gating so only high-confidence suggestions land in the ready-to-apply actions
- **Built-in knowledge base** — YNAB methodology docs (credit cards, targets, overspending, reconciliation) served as MCP resources
- **5 workflow prompts** — monthly reviews, spending reports, unapproved triage, budget optimization, and subscription audits
- **Read-only mode** — write tools are not even registered, so clients only see tools they can use
- **Efficient caching** — delta sync with YNAB's server knowledge system, configurable TTLs, and client-side rate-limit tracking

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

| Variable                    | Description                                                        | Default       |
| --------------------------- | ------------------------------------------------------------------ | ------------- |
| `YNAB_API_TOKEN`            | YNAB personal access token                                         | **required**  |
| `YNAB_API_URL`              | Override the YNAB API base URL                                     | YNAB default  |
| `YNAB_MCP_DATA_DIR`         | Directory for undo history storage                                 | `~/.ynab-mcp` |
| `YNAB_READ_ONLY`            | Hide and disable all write operations (`true`/`false`/`1`/`0`)     | `false`       |
| `YNAB_CACHE_TTL`            | Cache TTL in seconds for live data                                 | `3600`        |
| `YNAB_PAST_MONTH_CACHE_TTL` | Cache TTL in seconds for completed past months                     | `86400`       |
| `YNAB_UNDO_HISTORY_LIMIT`   | Undo entries kept per budget (oldest are dropped beyond this)      | `2000`        |

## Tools

### Budgets

| Tool               | Description                                                              |
| ------------------ | ------------------------------------------------------------------------ |
| `list_budgets`     | List all budgets with metadata                                           |
| `sync_budget_data` | Force-refresh cached data from YNAB                                      |

### Accounts

| Tool           | Description                                                       |
| -------------- | ----------------------------------------------------------------- |
| `get_accounts` | List accounts with balances, filterable by type and on/off budget |

### Transactions

| Tool                  | Description                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `search_transactions` | Search with filters (dates, amounts, accounts, categories, payees, flags, cleared status) — supports multiple queries in one call |
| `create_transactions` | Batch create transactions with optional splits (one bulk API call)                                                                 |
| `update_transactions` | Batch update existing transactions (one bulk API call; split changes are replaced via delete+recreate)                             |
| `delete_transactions` | Batch delete transactions (one API call per transaction)                                                                           |

### Categories

| Tool                   | Description                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `list_categories`      | Category group hierarchy with IDs and names                                          |
| `get_targets`          | Target details: type, amounts, underfunded, percent complete, cadence, and deadlines |
| `get_monthly_budget`   | Month-level budgeted/activity/balance per category                                   |
| `set_category_budgets` | Batch set budgeted amounts (one API call per category/month pair, max 50)            |
| `set_category_targets` | Create or update category targets (monthly, weekly, by-date, etc.)                   |

### Spending Analysis & Diagnostics

| Tool                         | Description                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `get_spending_analysis`      | Spending aggregates by category/payee with top-N ranking; optional `time_granularity` buckets spending over time   |
| `get_spending_trends`        | Multi-month time series by category, payee, or group; the partial current month is marked and excluded from trends |
| `get_income_expense_summary` | Income vs expense totals with savings rate; partial current month excluded from averages                           |
| `get_budget_health`          | Single-call snapshot: net worth, month totals, overspending, target gaps, credit card payment gaps, RTA, issues    |
| `detect_recurring_charges`   | Subscription and recurring charge detection from transaction history                                               |
| `detect_anomalies`           | Flag unusual transactions with leave-one-out statistical baselines                                                 |
| `get_money_movements`        | Audit feed of budget moves between categories or Ready to Assign, including moves made in the YNAB apps            |

All analysis tools are deterministic — no LLM sampling involved. They report facts and clearly-labeled statistical estimates; forecasting and reallocation decisions are left to the calling agent (the workflow prompts walk it through that reasoning using `get_targets`, `get_monthly_budget`, and `get_scheduled_transactions`).

### Scheduled Transactions

| Tool                            | Description                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `get_scheduled_transactions`    | List scheduled transactions with optional filters                            |
| `create_scheduled_transactions` | Batch create with any of the 13 YNAB frequencies (one API call per item)     |
| `update_scheduled_transactions` | Batch update scheduled transactions (one API call per item)                  |
| `delete_scheduled_transactions` | Batch delete scheduled transactions (one API call per item)                  |

### Smart Tools

| Tool                             | Description                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `suggest_transaction_categories` | Suggest categories for uncategorized transactions based on payee history and patterns |

Suggestions carry confidence levels; only those at or above `action_confidence` (default `high`) are included in the ready-to-apply `update_actions`, and approval is opt-in.

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

**Currency units** — All monetary amounts in tool inputs and outputs use standard currency units (e.g., `12.50`), not YNAB's native milliunits. Responses include a top-level `currency` ISO code.

**`budget_id`** — Most tools accept an optional `budget_id`. Omit it or pass `"last-used"` to target the most recently accessed budget.

**Undo** — Every write operation records an undo entry. Use `list_undo_history` and `undo_operations` to review or revert changes. The most recent 2000 entries per budget are kept (tunable via `YNAB_UNDO_HISTORY_LIMIT`).

**Read-only mode** — Set `YNAB_READ_ONLY=true` to hide and block all write operations. Useful for exploring your budget safely or restricting an MCP client to read-only access.

**Rate limiting** — The YNAB API allows 200 requests per rolling hour. The server tracks usage locally and reports when capacity frees up if the limit is reached. (The API used to expose an `X-Rate-Limit` header the tracker reconciled against; the live API no longer sends it, so the local tracker is the sole signal until a 429 confirms exhaustion.) Tools that cost one API call per item say so in their descriptions.

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
