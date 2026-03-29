/**
 * Shared seed data for integration tests.
 *
 * All dates are computed relative to the current date so that tools which
 * reference "recent months" (via `new Date()`) always find the seed data.
 */

import type { FakeBudgetBuilder } from "./fake-ynab/builder.js";

// ── Date helpers ──

/** Format a local Date as YYYY-MM-DD (avoids UTC shift from toISOString). */
function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** First day of the month that is `monthsAgo` months before today (YYYY-MM-DD). */
function monthStr(monthsAgo: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsAgo);
  return fmtDate(d);
}

/** Specific day within the month that is `monthsAgo` months before today (YYYY-MM-DD). */
export function dateStr(monthsAgo: number, day: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsAgo);
  d.setDate(day);
  return fmtDate(d);
}

/** First day of a month `monthsFromNow` months in the future (YYYY-MM-DD). */
function futureMonthStr(monthsFromNow: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + monthsFromNow);
  return fmtDate(d);
}

/** Specific day within the month that is `monthsFromNow` months in the future (YYYY-MM-DD). */
export function futureDateStr(monthsFromNow: number, day: number): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + monthsFromNow);
  d.setDate(day);
  return fmtDate(d);
}

/** End-of-month for a YYYY-MM-DD string. Parses the YYYY-MM-DD components to avoid timezone shifts. */
export function endOfMonth(dateStr: string): string {
  const [y, m] = dateStr.split("-").map(Number);
  const last = new Date(y, m, 0); // day 0 of next month = last day of this month
  return fmtDate(last);
}

// ── Exported date constants ──

/** Current month, 1st (e.g. "2026-03-01") */
export const CURRENT_MONTH = monthStr(0);
/** Last month, 1st */
export const LAST_MONTH = monthStr(1);
/** Two months ago, 1st */
export const TWO_MONTHS_AGO = monthStr(2);
/** Next month, 1st */
export const NEXT_MONTH = futureMonthStr(1);

export function seedStandardBudget(builder: FakeBudgetBuilder): void {
  builder
    .withSettings({ name: "My Budget" })

    // Accounts
    .withAccount("acct-checking", {
      name: "Checking",
      type: "checking",
      balance: 5000000,
    })
    .withAccount("acct-credit", {
      name: "Credit Card",
      type: "creditCard",
      balance: -1000000,
    })
    .withAccount("acct-savings", {
      name: "Savings",
      type: "savings",
      on_budget: false,
      balance: 10000000,
    })

    // Category Groups
    .withCategoryGroup("cg-everyday", "Everyday Expenses", [
      {
        id: "cat-groceries",
        name: "Groceries",
        budgeted: 400000,
        activity: -250000,
      },
      {
        id: "cat-dining",
        name: "Dining Out",
        budgeted: 200000,
        activity: -120000,
      },
      {
        id: "cat-transport",
        name: "Transportation",
        budgeted: 150000,
        activity: -80000,
      },
    ])
    .withCategoryGroup("cg-bills", "Monthly Bills", [
      {
        id: "cat-rent",
        name: "Rent/Mortgage",
        budgeted: 1500000,
        activity: -1500000,
      },
      {
        id: "cat-utilities",
        name: "Utilities",
        budgeted: 150000,
        activity: -95000,
      },
      {
        id: "cat-internet",
        name: "Internet",
        budgeted: 60000,
        activity: -55000,
      },
    ])
    .withCategoryGroup("cg-savings", "Savings Goals", [
      {
        id: "cat-emergency",
        name: "Emergency Fund",
        budgeted: 500000,
        activity: 0,
      },
      { id: "cat-vacation", name: "Vacation", budgeted: 200000, activity: 0 },
    ])

    // Payees
    .withPayee("payee-grocery", "Grocery Store")
    .withPayee("payee-restaurant", "Italian Restaurant")
    .withPayee("payee-gas", "Gas Station")
    .withPayee("payee-landlord", "Landlord")
    .withPayee("payee-electric", "Electric Company")
    .withPayee("payee-internet", "Internet Provider")

    // Transactions (10 spanning last 3 months: TWO_MONTHS_AGO, LAST_MONTH, CURRENT_MONTH)
    .withTransaction("tx-1", {
      account_id: "acct-checking",
      amount: -1500000,
      date: dateStr(2, 1),
      payee_id: "payee-landlord",
      category_id: "cat-rent",
      cleared: "cleared",
      memo: "January rent",
    })
    .withTransaction("tx-2", {
      account_id: "acct-checking",
      amount: -85000,
      date: dateStr(2, 5),
      payee_id: "payee-grocery",
      category_id: "cat-groceries",
      cleared: "cleared",
    })
    .withTransaction("tx-3", {
      account_id: "acct-credit",
      amount: -45000,
      date: dateStr(2, 12),
      payee_id: "payee-restaurant",
      category_id: "cat-dining",
      cleared: "cleared",
    })
    .withTransaction("tx-4", {
      account_id: "acct-checking",
      amount: -55000,
      date: dateStr(2, 15),
      payee_id: "payee-internet",
      category_id: "cat-internet",
      cleared: "cleared",
    })
    .withTransaction("tx-5", {
      account_id: "acct-checking",
      amount: -40000,
      date: dateStr(1, 3),
      payee_id: "payee-gas",
      category_id: "cat-transport",
      cleared: "cleared",
    })
    .withTransaction("tx-6", {
      account_id: "acct-checking",
      amount: -1500000,
      date: dateStr(1, 1),
      payee_id: "payee-landlord",
      category_id: "cat-rent",
      cleared: "cleared",
      memo: "February rent",
    })
    .withTransaction("tx-7", {
      account_id: "acct-credit",
      amount: -75000,
      date: dateStr(1, 10),
      payee_id: "payee-grocery",
      category_id: "cat-groceries",
      cleared: "cleared",
    })
    .withTransaction("tx-8", {
      account_id: "acct-checking",
      amount: -95000,
      date: dateStr(1, 20),
      payee_id: "payee-electric",
      category_id: "cat-utilities",
      cleared: "cleared",
    })
    .withTransaction("tx-9", {
      account_id: "acct-checking",
      amount: -1500000,
      date: dateStr(0, 1),
      payee_id: "payee-landlord",
      category_id: "cat-rent",
      cleared: "cleared",
      memo: "March rent",
    })
    .withTransaction("tx-10", {
      account_id: "acct-credit",
      amount: -35000,
      date: dateStr(0, 8),
      payee_id: "payee-restaurant",
      category_id: "cat-dining",
    })

    // Scheduled transactions
    .withScheduledTransaction("stx-rent", {
      account_id: "acct-checking",
      amount: -1500000,
      date_first: dateStr(2, 1),
      date_next: futureMonthStr(1),
      frequency: "monthly",
      payee_id: "payee-landlord",
      category_id: "cat-rent",
      memo: "Monthly rent",
    })
    .withScheduledTransaction("stx-internet", {
      account_id: "acct-checking",
      amount: -55000,
      date_first: dateStr(2, 15),
      date_next: dateStr(-1, 15),
      frequency: "monthly",
      payee_id: "payee-internet",
      category_id: "cat-internet",
      memo: "Monthly internet",
    })

    // Month detail for CURRENT_MONTH
    .withMonth(CURRENT_MONTH, {
      income: 6000000,
      budgeted: 3160000,
      activity: -3655000,
      to_be_budgeted: 2840000,
      age_of_money: 45,
    })

    .build();
}
