# YNAB Credit Card Handling

## How YNAB Models Credit Cards

Credit cards in YNAB are on-budget accounts with special behavior. YNAB automatically manages a "Credit Card Payment" category for each credit card, which tracks how much cash you have set aside to pay the card.

## The Credit Card Payment Category

When you budget money to a spending category and then spend it with a credit card, YNAB automatically moves that budgeted amount from the spending category's available balance to the credit card's payment category. This ensures you always know how much you need to pay your credit card bill.

**Example flow:**
1. You assign $100 to "Groceries"
2. You buy $60 of groceries on your credit card
3. YNAB moves $60 from "Groceries" available to "Credit Card Payment" available
4. "Groceries" now shows $40 available; "Credit Card Payment" shows $60 available
5. When you pay the card, the payment is a transfer from checking to the credit card — no category needed

## Key Mechanics

- **Budgeted spending on credit card**: Money moves automatically from the spending category to the credit card payment category. No action needed.

- **Paying the credit card**: Record as a transfer between your checking account and the credit card account. Do NOT assign a category — it's not spending, it's a transfer.

- **Credit card payment category "Available"**: Shows how much cash is reserved to pay this card. It should match the card balance if all spending was budgeted.

- **Assigning directly to the payment category**: You can budget money directly to the credit card payment category. This is used for paying down pre-YNAB debt (existing balance when you started YNAB).

## Credit Overspending vs Cash Overspending

- **Cash overspending** (debit/cash transaction in an overspent category): The negative balance carries forward to next month in that category, reducing next month's available.

- **Credit overspending** (credit card transaction in an overspent category): The overspent amount does NOT move to the credit card payment category. This means your payment category will be less than your card balance — you're carrying debt. The overspent category resets to zero next month, but the credit card payment category reflects the shortfall.

This distinction is critical: credit overspending creates credit card debt silently. The spending category resets to $0 next month (hiding the problem), but the credit card payment category is now short.

## Returns and Refunds

When a return or refund posts to your credit card:
- Categorize it to the same category as the original purchase
- YNAB moves the refunded amount back from the payment category to the spending category
- The payment category decreases (you owe less on the card)

## Pre-YNAB Debt

If your credit card had a balance when you started using YNAB:
1. The starting balance appears as a negative balance on the credit card account
2. The credit card payment category shows $0 (no cash set aside yet)
3. To pay down the debt, assign money directly to the credit card payment category each month
4. This is separate from the automatic movement that happens with new budgeted spending

## Common Mistakes

- **Categorizing credit card payments**: Payments to a credit card should be transfers, not categorized transactions. Categorizing them double-counts the spending.
- **Ignoring the payment available**: If the payment category available is less than the card balance, you have credit card debt building up from overspending.
- **Not budgeting to the payment category for pre-YNAB debt**: The automatic system only covers new spending. Old debt needs direct budget assignments.
