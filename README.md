# YNAB MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that connects LLMs to [YNAB (You Need A Budget)](https://www.ynab.com/). Ask Claude to review your budget, search transactions, create entries, analyze spending, and more — all through natural conversation.

## Features

- **Batch operations** — search, create, update, and delete transactions in bulk with a single tool call
- **Spending analysis** — aggregate and rank spending by category or payee over any date range
- **Smart suggestions** — suggest transaction categories and overspending coverage using local heuristics plus MCP client sampling when available
- **Undo with conflict detection** — every write operation is tracked and reversible, with automatic conflict checks before restoring state
- **Delta-aware caching with manual sync** — uses YNAB's server knowledge tokens to fetch only changed data and can force a refresh when needed
- **Read-only safety mode** — disable all write operations via environment variable
- **MCP resources** — expose both budget metadata and built-in YNAB methodology knowledge as browsable context
- **Workflow prompts** — pre-built prompts for monthly reviews, spending reports, and transaction triage

## Quick start

### Requirements

- Node.js 20+
- A [YNAB personal access token](https://app.ynab.com/settings/developer)

### Configure your MCP client

Add the server to your MCP client configuration. For example, in Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ynab": {
      "command": "npx",
      "args": ["-y", "@maro-org/ynab-mcp"],
      "env": {
        "YNAB_API_TOKEN": "your_token_here"
      }
    }
  }
}
```

The server communicates over stdio transport, so it works with any MCP-compatible client.

### From source

```bash
git clone https://github.com/maronato/ynab-mcp.git
cd ynab-mcp
npm install
npm run build
YNAB_API_TOKEN=your_token_here npm start
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `YNAB_API_TOKEN` | Yes | Your YNAB personal access token |
| `YNAB_API_URL` | No | Override the YNAB API base URL |
| `YNAB_MCP_DATA_DIR` | No | Directory for undo history files (default: `~/.ynab-mcp`) |
| `YNAB_READ_ONLY` | No | Disable writes when set to `true`/`1` and allow them when set to `false`/`0` |

## Tools

All write tools support batch operations and record undo history automatically.

### Budgets

| Tool | Description |
|---|---|
| `list_budgets` | List all available YNAB budgets |
| `get_budget_summary` | High-level snapshot: net worth, income, budgeted amount, activity, overspending |
| `sync_budget_data` | Force-refresh cached budget data after external changes such as bank imports or mobile app edits |

### Accounts

| Tool | Description |
|---|---|
| `get_accounts` | List accounts with optional filtering by type, on-budget status, or closed state |

### Transactions

| Tool | Description |
|---|---|
| `search_transactions` | Batch search with multiple queries — filter by date, account, category, payee, amount range, memo, cleared/approved status |
| `create_transactions` | Batch create transactions |
| `update_transactions` | Batch update existing transactions |
| `delete_transactions` | Batch delete transactions |

### Categories

| Tool | Description |
|---|---|
| `list_categories` | Lightweight category directory with group hierarchy, IDs, and names |
| `get_targets` | Target progress and underfunded data for categories in a given month |
| `get_monthly_budget` | Detailed monthly budget data with per-category budgeted, activity, and balance figures |
| `set_category_budgets` | Batch set budgeted amounts for categories in specific months |

### Spending analysis

| Tool | Description |
|---|---|
| `get_spending_analysis` | Aggregate spending by category, payee, or both — ranked by amount with configurable top-N |

### Smart suggestions

These tools are read-only and use MCP client sampling when available.

| Tool | Description |
|---|---|
| `suggest_transaction_categories` | Suggest categories for uncategorized or unapproved transactions and return `update_actions` you can apply with `update_transactions` |
| `suggest_overspending_coverage` | Suggest category rebalancing moves for overspending and return `set_budget_actions` you can apply with `set_category_budgets` |

### Scheduled transactions

| Tool | Description |
|---|---|
| `get_scheduled_transactions` | List recurring/scheduled transactions |
| `create_scheduled_transactions` | Batch create scheduled transactions |
| `update_scheduled_transactions` | Batch update scheduled transactions |
| `delete_scheduled_transactions` | Batch delete scheduled transactions |

### Undo

| Tool | Description |
|---|---|
| `list_undo_history` | View past write operations, scoped to the current session or all sessions |
| `undo_operations` | Revert one or more operations — checks for conflicts before restoring, with a `force` flag to override |

## Resources

MCP resources provide browsable context that clients can read without invoking tools.

### Budget data

| URI | Description |
|---|---|
| `ynab://budgets` | All available budgets |
| `ynab://budgets/{budget_id}/settings` | Date and currency settings |
| `ynab://budgets/{budget_id}/payees` | Payee directory |
| `ynab://budgets/{budget_id}/category-groups` | Category hierarchy |
| `ynab://budgets/{budget_id}/accounts` | Accounts and balances |

All parameterized resources support `last-used` as the budget ID and provide auto-completion suggestions.

### Knowledge

| URI | Description |
|---|---|
| `ynab://knowledge/terminology` | Core YNAB concepts, terms, transaction states, and month semantics |
| `ynab://knowledge/credit-cards` | Credit card spending, payments, debt, and returns in YNAB |
| `ynab://knowledge/targets` | Target types, underfunded calculations, and budgeting interactions |
| `ynab://knowledge/overspending` | Cash vs credit overspending and month rollover behavior |
| `ynab://knowledge/reconciliation` | Reconciliation workflow and transaction status lifecycle |

## Prompts

Pre-built workflow prompts guide the LLM through multi-step budgeting tasks.

| Prompt | Description |
|---|---|
| `monthly-review` | Structured monthly budget review — surfaces overspending, large outflows, and actionable suggestions |
| `spending-report` | Spending report for a date range — top categories/payees with percentages and patterns |
| `triage-unapproved` | Batch triage unapproved transactions — present, decide, update/delete in minimal tool calls |

## Docker / container usage

If you package the server in your own container image, mount a volume to the data directory for persistent undo history:

```bash
docker run -e YNAB_API_TOKEN=your_token \
  -e YNAB_MCP_DATA_DIR=/data/ynab-mcp \
  -v ynab-data:/data/ynab-mcp \
  your-custom-image
```

## Development

```bash
npm run dev          # Watch mode with tsx
npm run typecheck    # Type checking
npm run lint         # Biome linter
npm run lint:fix     # Auto-fix lint issues
npm run test         # Run tests with Vitest
npm run test:watch   # Tests in watch mode
npm run ci           # Full CI: typecheck + lint + test
```

`npm install` also runs `lefthook install` via the `prepare` script.

### Project structure

```
src/
├── index.ts              # Entry point — stdio transport setup
├── server.ts             # MCP server creation and registration
├── context.ts            # Shared AppContext
├── tools/                # MCP tool handlers
│   ├── budgets.ts        # Budget listing, summaries, and sync
│   ├── accounts.ts       # Account queries
│   ├── transactions.ts   # Transaction CRUD + search
│   ├── categories.ts     # Category queries and budget setting
│   ├── analysis.ts       # Spending aggregation
│   ├── scheduled.ts      # Scheduled transaction CRUD
│   ├── smart.ts          # Suggestion tools for categorization and rebalancing
│   └── undo.ts           # Undo history and operations
├── analysis/             # Heuristics for categorization and payee profiling
├── sampling/             # MCP client sampling wrapper
├── methodology/          # Bundled YNAB knowledge resources (*.md)
├── ynab/                 # YNAB API client layer
│   ├── client.ts         # Cached, delta-aware API wrapper
│   ├── rate-limiter.ts   # Client-side request guardrail
│   ├── errors.ts         # YNAB API error helpers
│   ├── types.ts          # TypeScript interfaces
│   └── format.ts         # Currency and snapshot formatting
├── undo/                 # Undo system
│   ├── engine.ts         # Conflict detection and undo execution
│   ├── store.ts          # Disk persistence
│   └── types.ts          # Undo type definitions
├── resources/            # MCP resource registrations
│   └── index.ts
├── prompts/              # MCP prompt registrations
│   └── index.ts
└── shared/               # Shared MCP and object helpers
```
