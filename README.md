# YNAB MCP Server

MCP server for YNAB with:

- Batch-capable search/write tools
- Concise, LLM-friendly responses
- Delta-aware YNAB caching for reference data
- Undo history with conflict detection and ID remapping
- MCP resources and prompts for common workflows

## Requirements

- Node.js 20+
- YNAB personal access token

## Environment variables

- `YNAB_API_TOKEN` (required): your YNAB access token
- `YNAB_API_URL` (optional): override API base URL
- `YNAB_MCP_DATA_DIR` (optional): data directory for undo/history files
  - Default: `~/.ynab-mcp`

## Install and build

```bash
npm install
npm run build
```

## Run

```bash
YNAB_API_TOKEN=your_token_here npm start
```

The server uses stdio transport and is suitable for MetaMCP container setups.

## MetaMCP / Docker note

For persistent undo/history state in containers, mount a volume and set:

```bash
YNAB_MCP_DATA_DIR=/data/ynab-mcp
```

## Primary tools

- `list_budgets`
- `get_budget_summary`
- `get_accounts`
- `search_transactions` (batch queries)
- `get_categories`
- `get_monthly_budget`
- `get_spending_analysis`
- `get_scheduled_transactions`
- `create_transactions` (batch)
- `update_transactions` (batch)
- `delete_transactions` (batch)
- `set_category_budgets` (batch)
- `create_scheduled_transactions` (batch)
- `update_scheduled_transactions` (batch)
- `delete_scheduled_transactions` (batch)
- `list_undo_history`
- `undo_operations`
