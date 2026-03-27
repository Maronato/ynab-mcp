# YNAB Reconciliation

## What Is Reconciliation?

Reconciliation is the process of verifying that your YNAB account balance matches your actual bank balance. It locks verified transactions so they can't be accidentally edited, giving you a known-good baseline.

## Transaction Status Lifecycle

1. **Uncleared** (gray) — Transaction entered manually or imported but not yet confirmed. The bank may not have processed it yet.

2. **Cleared** (green checkmark) — Transaction confirmed. Either:
   - Matched with an imported bank transaction
   - Manually marked as cleared by the user
   - Cleared means "yes, the bank has processed this"

3. **Reconciled** (lock icon) — Transaction verified during reconciliation. Cannot be edited without first un-reconciling. This is the final, trusted state.

## The Reconciliation Process

1. **Check your bank balance** — Log into your bank or check a statement
2. **Clear transactions in YNAB** — Mark all transactions that appear in your bank as cleared
3. **Compare balances** — YNAB shows your cleared balance. Compare it to the bank
4. **If they match** — Click "Reconcile." All cleared transactions become reconciled (locked)
5. **If they don't match** — Find the discrepancy. Common causes:
   - Missing transaction (in bank but not YNAB)
   - Duplicate transaction
   - Wrong amount on a transaction
   - Transaction cleared in YNAB that hasn't actually processed at the bank

## Reconciliation Adjustment

If you cannot find the discrepancy, YNAB offers to create a "Reconciliation Balance Adjustment" transaction to force the balance to match. This should be a last resort — it means there's an unexplained difference in your records.

The adjustment transaction:
- Is automatically reconciled
- Is categorized to "Inflows: Ready to Assign" (if positive) or needs a category (if negative)
- Should be investigated later to find the root cause

## Why Reconciliation Matters

- **Catches errors early** — Duplicate imports, wrong amounts, missing transactions
- **Prevents accidental edits** — Reconciled transactions are locked
- **Builds trust in data** — You know everything before the reconciliation point is accurate
- **Simplifies troubleshooting** — If balances diverge, you only need to check transactions after the last reconciliation

## Recommended Frequency

- **Checking accounts**: Every few days, or at least weekly. These have the most activity and the most opportunity for errors
- **Credit cards**: Weekly, or when the statement posts. Reconcile to the statement balance
- **Savings accounts**: Monthly, or when there's activity
- **Cash accounts**: Whenever you want — count physical cash and reconcile

## API Relevance

In the YNAB API:
- Transaction `cleared` field has three values: `uncleared`, `cleared`, `reconciled`
- You can set a transaction to `cleared` but not directly to `reconciled` via the API — reconciliation is a user-initiated process in the YNAB app
- When searching or filtering transactions, the cleared status helps determine data quality and recency
- Uncleared transactions may still change (amount corrections, categorization)
- Reconciled transactions are the most reliable data points
