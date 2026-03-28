# YNAB API Quirks and Limitations

Known limitations of the YNAB API that affect what you can do through this MCP server.

## Scheduled Transaction Frequencies

### Only 5 frequency values are supported for create and update

When creating or updating scheduled transactions, you can only use these frequency values:

- `never`
- `daily`
- `weekly`
- `monthly`
- `yearly`

All other values (e.g., `everyOtherWeek`, `twiceAMonth`, `every4Months`) will be rejected.

### Compound-frequency transactions are read-only

Scheduled transactions created through the YNAB app can use compound frequencies like `every4Months` or `twiceAMonth`. These appear normally when reading scheduled transactions, but **cannot be modified through the API at all** — not even to change unrelated fields like memo or amount. The API rejects the entire update.

These transactions must be edited directly in the YNAB app.

| Operation | Compound frequency | Simple frequency |
|-----------|-------------------|-----------------|
| Create | Rejected | Works |
| Read | Works | Works |
| Update (any field) | **Rejected** | Works |
| Delete | Works | Works |

## Split (Multi-Category) Transactions

### Creating splits

To create a split transaction, provide a `subtransactions` array on the transaction. Each subtransaction has its own `amount`, `category_id`, and optional `memo`. Subtransaction amounts must sum to the parent `amount`. The parent `category_id` can be omitted — YNAB assigns a special "Split" category automatically.

### Modifying splits

The YNAB API does not support modifying `subtransactions` or `category_id` on an existing split transaction — those changes are silently ignored. The MCP server works around this by transparently deleting and recreating the transaction when you change split-related fields. This means:

- Changing `subtransactions` or `category_id` on a split works as expected through `update_transactions`
- The transaction will get a **new ID** after such an update — check `current_transaction_id` in the result
- Non-split fields (memo, flag, date, amount, payee, cleared, approved) are updated normally without changing the ID

### Converting between split and non-split

- Converting a non-split transaction to a split (by adding `subtransactions`) works
- Un-splitting (setting a `category_id` on a split) also works — the server handles it via replace

## Scheduled Transaction Date Validation

When updating a scheduled transaction, the date must be no more than 1 week in the past and no more than 5 years in the future. Old scheduled transactions with a `date_first` far in the past may fail to update for this reason.
