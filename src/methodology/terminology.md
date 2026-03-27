# YNAB Terminology and Core Concepts

## The Four Rules

YNAB's budgeting methodology is built on four rules:

1. **Give Every Dollar a Job** — Every dollar of income must be assigned to a specific category. There should be no unassigned money sitting in "Ready to Assign" (formerly "To Be Budgeted"). This forces intentional spending decisions.

2. **Embrace Your True Expenses** — Large, infrequent expenses (insurance premiums, annual subscriptions, car maintenance) should be broken into monthly amounts and budgeted for each month. This prevents "surprise" expenses.

3. **Roll With the Punches** — When you overspend in a category, move money from another category to cover it. The budget is a living plan, not a rigid constraint. Adjust as life happens.

4. **Age Your Money** — The goal is to spend money that is at least 30 days old, meaning you're living on last month's income rather than this month's. This breaks the paycheck-to-paycheck cycle.

## Key Terms

- **Ready to Assign (RTA)** — Money that has been received but not yet assigned to any category. Previously called "To Be Budgeted" (TBB). Should ideally be zero after budgeting.

- **Assigned** — The amount budgeted (assigned) to a category for the current month. This is the money you plan to have available for that category's purpose.

- **Activity** — The sum of transactions in a category for the current month. Negative activity means spending; positive activity means inflows (refunds, income categorized to that category).

- **Available** — The running balance in a category: previous month's available + this month's assigned + this month's activity. This is how much you can still spend in that category.

- **Milliunits** — YNAB's internal currency representation. 1 currency unit = 1,000 milliunits. For example, $25.99 = 25,990 milliunits. All API amounts use milliunits.

- **On-Budget Accounts** — Accounts whose transactions affect category balances (checking, savings, credit cards, cash). These are the accounts you actively budget with.

- **Off-Budget Accounts** — Tracking accounts for assets and liabilities not part of daily budgeting (investment accounts, mortgages, car loans). Transactions here don't affect categories.

- **Age of Money** — The average age (in days) of the dollars you spend. Calculated by looking at when the money you're currently spending was originally received. A higher number (30+ days) means you're ahead of the paycheck cycle.

- **Category Group** — A folder-like container that groups related categories (e.g., "Fixed Expenses" might contain Rent, Utilities, Insurance).

## Transaction States

- **Uncleared** — Transaction has been entered but not yet confirmed by the bank. Shown with a gray indicator.
- **Cleared** — Transaction has been confirmed by the bank (matched with an imported transaction or manually cleared). Shown with a green checkmark.
- **Reconciled** — Transaction has been verified during reconciliation and is locked from editing. Shown with a lock icon.

## Budget Months

YNAB organizes budgets by month. Each month has its own set of category assignments and balances. Available balances roll forward from month to month — if you have $50 available in "Groceries" at the end of January, that $50 carries into February's available balance before any new assignments.

## Transfers

Transfers between on-budget accounts don't need categories — they're just moving money between accounts. Transfers between an on-budget and off-budget account do need categories because money is leaving (or entering) the budget.
