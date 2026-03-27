# YNAB Targets

## Overview

Targets help you plan and track funding for categories. Each category can have one target that defines a target amount, a timeframe, or both. Targets drive the "Underfunded" calculation, which tells you how much more you need to assign to stay on track.

## Target Types

### Target Category Balance ("Savings Balance")
- **Purpose**: Build up to a specific balance in the category
- **Example**: Emergency fund of $10,000
- **Optional target date**: If set, YNAB calculates a monthly funding amount to reach the target by that date
- **Underfunded calculation**: (Target amount - current available) / months remaining. If no target date, the full remaining amount is shown as underfunded
- **Behavior**: Once the target is reached, underfunded shows $0. Spending from the category increases underfunded again

### Monthly Savings Builder ("Monthly Contribution")
- **Purpose**: Assign a fixed amount to the category every month
- **Example**: $200/month to vacation fund
- **Underfunded calculation**: Target monthly amount - amount already assigned this month
- **Behavior**: Resets each month. Does not consider available balance — even if the category has surplus, it still asks for the monthly amount

### Needed for Spending ("Spending Target")
- **Purpose**: Ensure a specific amount is available for spending by a target date
- **Example**: $600 needed for insurance premium due in June
- **With monthly target date**: Useful for recurring expenses. YNAB asks for the same amount each month
- **With future target date**: YNAB divides the remaining needed amount across remaining months
- **Underfunded calculation**: Accounts for what's already available and divides the shortfall across remaining months

### Monthly Debt Payment
- **Purpose**: Specifically for credit card or loan debt payoff
- **Example**: Pay $500/month toward credit card debt
- **Behavior**: Similar to Monthly Savings Builder but tailored for debt accounts

## Underfunded

"Underfunded" is the amount you need to assign to a category to keep its target on track this month. It appears as an orange indicator on the category.

- If a category is fully funded for the month, it shows a green checkmark
- If a category has more than needed, it shows a green indicator with the surplus
- If underfunded, the orange amount tells you exactly how much more to assign

**Quick Budget actions use underfunded**: The "Underfunded" quick budget option assigns exactly the underfunded amount to each selected category.

## Target Interactions with Budgeting

- Targets don't move money automatically — they only inform you how much to assign
- Available balance from previous months counts toward targets. If your "Emergency Fund" target is $10,000 and you already have $8,000 available, only $2,000 (or its monthly portion) shows as underfunded
- Spending from a category with a Savings Balance target increases the underfunded amount
- Monthly targets (Savings Builder, monthly Needed for Spending) reset their funding requirement each month regardless of surplus

## Common Patterns

- **Bills**: Use "Needed for Spending" with a monthly repeat for recurring bills
- **Savings**: Use "Target Category Balance" with a target date for specific savings targets
- **Subscriptions**: Use "Needed for Spending" with the billing cycle date
- **Irregular expenses**: Use "Needed for Spending" with the due date, start funding months in advance
