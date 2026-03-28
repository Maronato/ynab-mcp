# YNAB MCP Server

An MCP server for YNAB with batch operations, robust undo support, and LLM-assisted smart tools.

> [!NOTE]  
> **AI Disclosure:** This project was built with Claude Code and Cursor. It works and is tested, but the code is largely clanker-made.

## Highlights

- **22 tools** covering budgets, accounts, transactions, categories, targets, scheduled transactions, and spending analysis
- **Batch operations** — create, update, and delete multiple transactions or category assignments in a single call
- **Undo support** — every write operation is recorded and reversible, scoped to sessions with configurable TTL
- **Smart tools** — LLM-assisted transaction categorization and overspending coverage suggestions via [MCP sampling](https://modelcontextprotocol.io/docs/concepts/sampling)
- **Built-in knowledge base** — YNAB methodology docs (credit cards, targets, overspending, reconciliation) served as MCP resources
- **Workflow prompts** — pre-built prompts for monthly reviews, spending reports, and unapproved transaction triage
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

| Variable                 | Description                                           | Default       |
| ------------------------ | ----------------------------------------------------- | ------------- |
| `YNAB_API_TOKEN`         | YNAB personal access token                            | **required**  |
| `YNAB_API_URL`           | Override the YNAB API base URL                        | YNAB default  |
| `YNAB_MCP_DATA_DIR`      | Directory for undo history storage                    | `~/.ynab-mcp` |
| `YNAB_READ_ONLY`         | Disable all write operations (`true`/`false`/`1`/`0`) | `false`       |
| `YNAB_REQUIRE_SESSION`   | Require explicit `session_id` on every write          | `false`       |
| `YNAB_SESSION_TTL_HOURS` | How long undo history is retained                     | `24`          |

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

| Tool                   | Description                                                  |
| ---------------------- | ------------------------------------------------------------ |
| `list_categories`      | Category group hierarchy with IDs and names                  |
| `get_targets`          | Target details: type, amounts, underfunded, percent complete |
| `get_monthly_budget`   | Month-level budgeted/activity/balance per category           |
| `set_category_budgets` | Batch set budgeted amounts across categories and months      |

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

These use [MCP sampling](https://modelcontextprotocol.io/docs/concepts/sampling) to ask the host LLM for help when available, falling back to heuristics otherwise.

| Tool                             | Description                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `suggest_transaction_categories` | Suggest categories for uncategorized transactions based on payee history and patterns |
| `suggest_overspending_coverage`  | Suggest budget moves to cover overspent categories from surplus ones                  |

Both return structured actions that can be passed directly to `update_transactions` or `set_category_budgets`.

### Sessions & Undo

| Tool                | Description                                      |
| ------------------- | ------------------------------------------------ |
| `setup_session`     | Create a new session ID for scoping undo history |
| `list_undo_history` | List recorded undo entries for a session         |
| `undo_operations`   | Undo one or more previous write operations by ID |

## Resources

### Budget Data

| URI                                          | Description                                       |
| -------------------------------------------- | ------------------------------------------------- |
| `ynab://budgets`                             | All budgets (ID, name, last modified, date range) |
| `ynab://budgets/{budget_id}/settings`        | Budget plan settings                              |
| `ynab://budgets/{budget_id}/payees`          | Payee directory                                   |
| `ynab://budgets/{budget_id}/category-groups` | Category group and category hierarchy             |
| `ynab://budgets/{budget_id}/accounts`        | Accounts with balances                            |

### Knowledge Base

| URI                               | Topic                              |
| --------------------------------- | ---------------------------------- |
| `ynab://knowledge/terminology`    | Core YNAB concepts and terminology |
| `ynab://knowledge/credit-cards`   | Credit card handling               |
| `ynab://knowledge/targets`        | Target types and behavior          |
| `ynab://knowledge/overspending`   | Overspending mechanics             |
| `ynab://knowledge/reconciliation` | Reconciliation workflow            |
| `ynab://knowledge/api-quirks`     | API quirks and limitations         |

## Prompts

| Prompt              | Description                                      |
| ------------------- | ------------------------------------------------ |
| `monthly-review`    | Guided monthly budget review                     |
| `spending-report`   | Spending report for a date range                 |
| `triage-unapproved` | Batch review and approve unapproved transactions |

## Key Concepts

**Currency units** — All monetary amounts in tool inputs and outputs use standard currency units (e.g., `12.50`), not YNAB's native milliunits. The server handles conversion automatically.

**`budget_id`** — Most tools accept an optional `budget_id`. Omit it or pass `"last-used"` to target the most recently accessed budget.

**Sessions & undo** — Every write operation records an undo entry. By default, all operations share a single session. Call `setup_session` to get an isolated session ID, then pass it as `session_id` on write calls to scope undo history. Set `YNAB_REQUIRE_SESSION=true` to enforce this. Undo entries expire after `YNAB_SESSION_TTL_HOURS` (default 24).

**Read-only mode** — Set `YNAB_READ_ONLY=true` to block all write operations. Useful for exploring your budget safely or restricting an MCP client to read-only access.

**Smart tools & sampling** — `suggest_transaction_categories` and `suggest_overspending_coverage` use MCP's sampling capability to ask the host LLM for help with ambiguous decisions. If the MCP client doesn't support sampling, the tools fall back to deterministic heuristics.

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
