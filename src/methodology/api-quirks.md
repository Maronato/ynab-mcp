# YNAB API Quirks and Limitations

Known limitations of the YNAB API that affect what you can do through this MCP server.

## Scheduled Transaction Frequencies

The current YNAB API spec accepts the full 13-value frequency enum on create
and update — the same values it returns on reads: `never`, `daily`, `weekly`,
`everyOtherWeek`, `twiceAMonth`, `every4Weeks`, `monthly`, `everyOtherMonth`,
`every3Months`, `every4Months`, `twiceAYear`, `yearly`, `everyOtherYear`.

Earlier API versions rejected compound values (like `everyOtherWeek`) on
writes and refused any update to a compound-frequency scheduled transaction.
That restriction is no longer in the spec — but note the evidence differs in
kind: the old restriction was observed against the live API, while its
removal is so far only established from the published spec (write access was
not available to re-verify it). If the live API still rejects a compound
value, the per-item error result of the create/update tool reports it
without failing the rest of the batch; fall back to a simple frequency plus
a memo naming the real cadence in that case.

Two constraints that do still apply:

- The scheduled transaction `date` must be in the future and no more than
  5 years out.
- Scheduled transactions cannot have splits (subtransactions) through the
  API; split scheduled transactions can only be managed in the YNAB app.

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
