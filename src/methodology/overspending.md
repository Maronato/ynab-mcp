# YNAB Overspending

## What Is Overspending?

A category is overspent when its available balance goes negative — you've spent more than what was assigned (plus any rollover from previous months). Overspending is shown in red (cash) or orange (credit) in YNAB.

## Cash vs Credit Overspending

The type of overspending depends on the payment method used for the transaction:

### Cash Overspending (Red)
- Caused by debit card, bank transfer, or cash transactions in an overspent category
- **Month rollover**: The negative balance carries forward into the next month. The category starts the new month with a negative available balance
- **Impact**: Directly reduces the money available in that category next month
- **Resolution**: Move money from another category to cover it this month, or accept the reduced balance next month

### Credit Overspending (Orange)
- Caused by credit card transactions in an overspent category
- **Month rollover**: The overspent category resets to $0 next month — the negative balance does NOT carry forward in the spending category
- **Hidden impact**: The overspent amount is NOT moved to the credit card payment category, creating a gap between your payment category available and your actual card balance. This gap is credit card debt
- **Resolution**: Cover the overspending this month by moving money from another category. If not covered before month rollover, the debt silently transfers to the credit card

## Why Credit Overspending Is Dangerous

Credit overspending is more insidious than cash overspending because:

1. The spending category resets to $0 next month, hiding the problem
2. The credit card payment category quietly falls behind the card balance
3. Unless you check the payment category vs card balance, you won't notice the growing debt
4. Each month of uncovered credit overspending compounds the gap

## Covering Overspending

To cover overspending (Rule 3: Roll With the Punches):

1. Identify categories with available surplus
2. Move money from surplus categories to overspent categories
3. Priority order for sourcing funds:
   - Categories with excess surplus beyond their target
   - Categories you can safely reduce this month
   - **Never** take from credit card payment categories (this creates debt)
   - **Avoid** taking from categories with upcoming bills

In the YNAB API, moving money between categories is done by adjusting the "assigned" (budgeted) amounts: decrease the source category's assigned amount and increase the destination category's assigned amount by the same amount.

## Month-End Behavior

At the turn of the month:
- **Cash overspent categories**: Negative available carries forward (e.g., -$50 available becomes -$50 in the new month before any assignments)
- **Credit overspent categories**: Available resets to $0, but the credit card payment category is now short by that amount
- **Positive available categories**: Balance carries forward as expected

## Best Practices

- Cover all overspending before the month ends, especially credit overspending
- Check credit card payment categories regularly — they should match card balances
- Use the "Overspent" filter/sort in the budget view to quickly find problems
- When suggesting fixes, prioritize covering credit overspending over cash overspending due to the hidden debt risk
