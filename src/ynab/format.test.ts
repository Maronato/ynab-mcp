import { describe, expect, it } from "vitest";

import {
  createMockCurrencyFormat,
  createMockNameLookup,
  createMockScheduledTransaction,
  createMockSplitTransaction,
  createMockTransaction,
} from "../test-utils.js";

import {
  currencyToMilliunits,
  formatCurrency,
  formatScheduledTransactionForOutput,
  formatTransactionForOutput,
  milliunitsToCurrency,
  snapshotScheduledTransaction,
  snapshotTransaction,
} from "./format.js";

describe("currencyToMilliunits", () => {
  it("converts integer amounts", () => {
    expect(currencyToMilliunits(5)).toBe(5000);
  });

  it("converts decimal amounts", () => {
    expect(currencyToMilliunits(5.5)).toBe(5500);
  });

  it("handles negative amounts", () => {
    expect(currencyToMilliunits(-3.25)).toBe(-3250);
  });

  it("rounds floating point edge cases", () => {
    expect(currencyToMilliunits(1.9999)).toBe(2000);
    expect(currencyToMilliunits(1.999)).toBe(1999);
  });

  it("handles zero", () => {
    expect(currencyToMilliunits(0)).toBe(0);
  });
});

describe("milliunitsToCurrency", () => {
  it("converts round amounts", () => {
    expect(milliunitsToCurrency(5000)).toBe(5);
    expect(milliunitsToCurrency(-3250)).toBe(-3.25);
  });

  it("handles non-round amounts", () => {
    expect(milliunitsToCurrency(1)).toBe(0.001);
  });
});

describe("formatCurrency", () => {
  it("formats with defaults", () => {
    expect(formatCurrency(5500)).toBe("$5.50");
  });

  it("formats negative amounts with defaults", () => {
    expect(formatCurrency(-5500)).toBe("-$5.50");
  });

  it("uses custom symbol", () => {
    expect(formatCurrency(1000000, { currency_symbol: "EUR" })).toBe(
      "EUR1,000.00",
    );
  });

  it("places symbol after value when symbol_first is false", () => {
    expect(formatCurrency(5500, { symbol_first: false })).toBe("5.50$");
  });

  it("omits symbol when display_symbol is false", () => {
    expect(formatCurrency(5500, { display_symbol: false })).toBe("5.50");
  });

  it("formats European style with custom separators", () => {
    const format = createMockCurrencyFormat({
      decimal_separator: ",",
      group_separator: ".",
    });
    expect(formatCurrency(1234567, format)).toBe("$1.234,57");
  });

  it("omits decimals when decimal_digits is 0", () => {
    expect(formatCurrency(5500, { decimal_digits: 0 })).toBe("$6");
  });

  it("shows three decimal places when decimal_digits is 3", () => {
    expect(formatCurrency(5500, { decimal_digits: 3 })).toBe("$5.500");
  });

  it("formats negative with symbol_first false", () => {
    expect(formatCurrency(-5500, { symbol_first: false })).toBe("-5.50$");
  });

  it("formats large amounts with grouping", () => {
    expect(formatCurrency(1234567890)).toBe("$1,234,567.89");
  });
});

describe("snapshotTransaction", () => {
  it("copies all fields from a full transaction", () => {
    const tx = createMockTransaction();
    const snapshot = snapshotTransaction(tx);

    expect(snapshot).toEqual({
      id: "tx-1",
      account_id: "acc-1",
      date: "2024-01-15",
      amount: -50000,
      payee_id: "payee-1",
      payee_name: null,
      category_id: "cat-1",
      memo: "Groceries",
      cleared: "cleared",
      approved: true,
      flag_color: null,
    });
  });

  it("normalizes undefined optional fields to null", () => {
    const tx = createMockTransaction({
      payee_id: undefined,
      category_id: undefined,
      memo: undefined,
      flag_color: undefined,
    });
    const snapshot = snapshotTransaction(tx);

    expect(snapshot.payee_id).toBeNull();
    expect(snapshot.category_id).toBeNull();
    expect(snapshot.memo).toBeNull();
    expect(snapshot.flag_color).toBeNull();
  });

  it("includes subtransactions for split transactions", () => {
    const tx = createMockSplitTransaction();
    const snapshot = snapshotTransaction(tx);

    expect(snapshot.subtransactions).toHaveLength(2);
    const subs = snapshot.subtransactions as Array<Record<string, unknown>>;
    expect(subs[0]).toEqual({
      amount: -30000,
      payee_id: null,
      category_id: "cat-1",
      memo: null,
    });
    expect(subs[1]).toEqual({
      amount: -20000,
      payee_id: null,
      category_id: "cat-2",
      memo: null,
    });
  });

  it("omits subtransactions for non-split transactions", () => {
    const tx = createMockTransaction();
    const snapshot = snapshotTransaction(tx);

    expect(snapshot.subtransactions).toBeUndefined();
  });

  it("sorts subtransactions deterministically regardless of input order", () => {
    const tx = createMockSplitTransaction({
      subtransactions: [
        {
          id: "sub-z",
          transaction_id: "tx-split",
          amount: -20000,
          category_id: "cat-z",
          category_name: "Z Category",
          deleted: false,
          payee_id: null,
          payee_name: null,
          memo: null,
          transfer_account_id: null,
          transfer_transaction_id: null,
        },
        {
          id: "sub-a",
          transaction_id: "tx-split",
          amount: -30000,
          category_id: "cat-a",
          category_name: "A Category",
          deleted: false,
          payee_id: null,
          payee_name: null,
          memo: null,
          transfer_account_id: null,
          transfer_transaction_id: null,
        },
      ],
    });

    const snapshotA = snapshotTransaction(tx);
    const subsA = snapshotA.subtransactions as Array<Record<string, unknown>>;

    const txReversed = createMockSplitTransaction({
      subtransactions: [
        {
          id: "sub-a",
          transaction_id: "tx-split",
          amount: -30000,
          category_id: "cat-a",
          category_name: "A Category",
          deleted: false,
          payee_id: null,
          payee_name: null,
          memo: null,
          transfer_account_id: null,
          transfer_transaction_id: null,
        },
        {
          id: "sub-z",
          transaction_id: "tx-split",
          amount: -20000,
          category_id: "cat-z",
          category_name: "Z Category",
          deleted: false,
          payee_id: null,
          payee_name: null,
          memo: null,
          transfer_account_id: null,
          transfer_transaction_id: null,
        },
      ],
    });

    const snapshotB = snapshotTransaction(txReversed);
    const subsB = snapshotB.subtransactions as Array<Record<string, unknown>>;

    expect(subsA).toEqual(subsB);
  });

  it("sorts deterministically when category_id and amount are identical", () => {
    const tx = createMockSplitTransaction({
      subtransactions: [
        {
          id: "sub-b",
          transaction_id: "tx-split",
          amount: -10000,
          category_id: "cat-1",
          category_name: "Groceries",
          deleted: false,
          payee_id: "payee-b",
          payee_name: "Payee B",
          memo: "b memo",
          transfer_account_id: null,
          transfer_transaction_id: null,
        },
        {
          id: "sub-a",
          transaction_id: "tx-split",
          amount: -10000,
          category_id: "cat-1",
          category_name: "Groceries",
          deleted: false,
          payee_id: "payee-a",
          payee_name: "Payee A",
          memo: "a memo",
          transfer_account_id: null,
          transfer_transaction_id: null,
        },
      ],
    });
    const reversed = createMockSplitTransaction({
      subtransactions: [
        {
          id: "sub-a",
          transaction_id: "tx-split",
          amount: -10000,
          category_id: "cat-1",
          category_name: "Groceries",
          deleted: false,
          payee_id: "payee-a",
          payee_name: "Payee A",
          memo: "a memo",
          transfer_account_id: null,
          transfer_transaction_id: null,
        },
        {
          id: "sub-b",
          transaction_id: "tx-split",
          amount: -10000,
          category_id: "cat-1",
          category_name: "Groceries",
          deleted: false,
          payee_id: "payee-b",
          payee_name: "Payee B",
          memo: "b memo",
          transfer_account_id: null,
          transfer_transaction_id: null,
        },
      ],
    });

    const subsA = snapshotTransaction(tx).subtransactions as Array<
      Record<string, unknown>
    >;
    const subsB = snapshotTransaction(reversed).subtransactions as Array<
      Record<string, unknown>
    >;

    expect(subsA).toEqual(subsB);
  });
});

describe("snapshotScheduledTransaction", () => {
  it("maps date_first to date and includes frequency", () => {
    const stx = createMockScheduledTransaction();
    const snapshot = snapshotScheduledTransaction(stx);

    expect(snapshot).toEqual({
      id: "stx-1",
      account_id: "acc-1",
      date: "2024-01-01",
      amount: -100000,
      payee_id: "payee-1",
      payee_name: null,
      category_id: "cat-1",
      memo: "Rent",
      frequency: "monthly",
      flag_color: null,
    });
  });

  it("normalizes undefined optional fields to null", () => {
    const stx = createMockScheduledTransaction({
      payee_id: undefined,
      category_id: undefined,
      memo: undefined,
      flag_color: undefined,
    });
    const snapshot = snapshotScheduledTransaction(stx);

    expect(snapshot.payee_id).toBeNull();
    expect(snapshot.category_id).toBeNull();
    expect(snapshot.memo).toBeNull();
    expect(snapshot.flag_color).toBeNull();
  });
});

describe("formatTransactionForOutput", () => {
  it("enriches transaction with names from lookups", () => {
    const tx = createMockTransaction();
    const lookups = createMockNameLookup();
    const result = formatTransactionForOutput(tx, lookups);

    expect(result.account_name).toBe("Checking");
    expect(result.payee_name).toBe("Supermarket");
    expect(result.category_name).toBe("Groceries");
  });

  it("includes category_group_id and category_group_name", () => {
    const tx = createMockTransaction();
    const lookups = createMockNameLookup();
    const result = formatTransactionForOutput(tx, lookups);

    expect(result.category_group_id).toBe("group-1");
    expect(result.category_group_name).toBe("Everyday");
  });

  it("returns null category group fields when category_id is null", () => {
    const tx = createMockTransaction({ category_id: null });
    const lookups = createMockNameLookup();
    const result = formatTransactionForOutput(tx, lookups);

    expect(result.category_id).toBeNull();
    expect(result.category_name).toBeNull();
    expect(result.category_group_id).toBeNull();
    expect(result.category_group_name).toBeNull();
  });

  it("returns null category group fields for unknown category_id", () => {
    const tx = createMockTransaction({ category_id: "unknown-cat" });
    const lookups = createMockNameLookup();
    const result = formatTransactionForOutput(tx, lookups);

    expect(result.category_name).toBeNull();
    expect(result.category_group_id).toBeNull();
    expect(result.category_group_name).toBeNull();
  });

  it("falls back to null when payee_id is null", () => {
    const tx = createMockTransaction({ payee_id: null });
    const lookups = createMockNameLookup();
    const result = formatTransactionForOutput(tx, lookups);

    expect(result.payee_name).toBeNull();
  });

  it("falls back to null when lookup does not contain the ID", () => {
    const tx = createMockTransaction({
      account_id: "unknown-acc",
      payee_id: "unknown-payee",
      category_id: "unknown-cat",
    });
    const lookups = createMockNameLookup();
    const result = formatTransactionForOutput(tx, lookups);

    expect(result.account_name).toBeNull();
    expect(result.payee_name).toBeNull();
    expect(result.category_name).toBeNull();
  });

  it("converts amount from milliunits and produces amount_display", () => {
    const tx = createMockTransaction({ amount: -50000 });
    const lookups = createMockNameLookup();
    const format = createMockCurrencyFormat();
    const result = formatTransactionForOutput(tx, lookups, format);

    expect(result.amount).toBe(-50);
    expect(result.amount_display).toBe("-$50.00");
  });

  it("normalizes memo and flag_color undefined to null", () => {
    const tx = createMockTransaction({
      memo: undefined,
      flag_color: undefined,
    });
    const lookups = createMockNameLookup();
    const result = formatTransactionForOutput(tx, lookups);

    expect(result.memo).toBeNull();
    expect(result.flag_color).toBeNull();
  });

  it("sets is_split to false for non-split transactions", () => {
    const tx = createMockTransaction();
    const lookups = createMockNameLookup();
    const result = formatTransactionForOutput(tx, lookups);

    expect(result.is_split).toBe(false);
    expect(result).not.toHaveProperty("subtransactions");
  });

  it("sets is_split to true and includes formatted subtransactions for splits", () => {
    const tx = createMockSplitTransaction();
    const lookups = createMockNameLookup({
      categoryById: new Map([
        [
          "cat-1",
          { name: "Groceries", group_id: "group-1", group_name: "Everyday" },
        ],
        [
          "cat-2",
          { name: "Entertainment", group_id: "group-2", group_name: "Fun" },
        ],
      ]),
    });
    const format = createMockCurrencyFormat();
    const result = formatTransactionForOutput(tx, lookups, format);

    expect(result.is_split).toBe(true);
    expect(result.subtransactions).toHaveLength(2);

    const subs = result.subtransactions as Array<Record<string, unknown>>;
    const sub1 = subs[0];
    expect(sub1.id).toBe("sub-1");
    expect(sub1.amount).toBe(-30);
    expect(sub1.amount_display).toBe("-$30.00");
    expect(sub1.category_id).toBe("cat-1");
    expect(sub1.category_name).toBe("Groceries");
    expect(sub1.category_group_id).toBe("group-1");
    expect(sub1.category_group_name).toBe("Everyday");

    const sub2 = subs[1];
    expect(sub2.category_id).toBe("cat-2");
    expect(sub2.category_name).toBe("Entertainment");
    expect(sub2.category_group_name).toBe("Fun");
  });

  it("excludes deleted subtransactions from output", () => {
    const tx = createMockSplitTransaction({
      subtransactions: [
        {
          id: "sub-1",
          transaction_id: "tx-split",
          amount: -30000,
          category_id: "cat-1",
          category_name: "Groceries",
          deleted: false,
          payee_id: null,
          payee_name: null,
          memo: null,
          transfer_account_id: null,
          transfer_transaction_id: null,
        },
        {
          id: "sub-2",
          transaction_id: "tx-split",
          amount: -20000,
          category_id: "cat-2",
          category_name: "Entertainment",
          deleted: true,
          payee_id: null,
          payee_name: null,
          memo: null,
          transfer_account_id: null,
          transfer_transaction_id: null,
        },
      ],
    });
    const lookups = createMockNameLookup();
    const result = formatTransactionForOutput(tx, lookups);

    expect(result.is_split).toBe(true);
    expect(result.subtransactions).toHaveLength(1);
    const deletedSubs = result.subtransactions as Array<
      Record<string, unknown>
    >;
    expect(deletedSubs[0].id).toBe("sub-1");
  });
});

describe("formatScheduledTransactionForOutput", () => {
  it("enriches with names and includes scheduled fields", () => {
    const stx = createMockScheduledTransaction();
    const lookups = createMockNameLookup();
    const result = formatScheduledTransactionForOutput(stx, lookups);

    expect(result.date_first).toBe("2024-01-01");
    expect(result.date_next).toBe("2024-02-01");
    expect(result.frequency).toBe("monthly");
    expect(result.account_name).toBe("Checking");
    expect(result.payee_name).toBe("Supermarket");
    expect(result.category_name).toBe("Groceries");
  });

  it("includes category_group_id and category_group_name", () => {
    const stx = createMockScheduledTransaction();
    const lookups = createMockNameLookup();
    const result = formatScheduledTransactionForOutput(stx, lookups);

    expect(result.category_group_id).toBe("group-1");
    expect(result.category_group_name).toBe("Everyday");
  });

  it("returns null category group fields when category_id is null", () => {
    const stx = createMockScheduledTransaction({ category_id: null });
    const lookups = createMockNameLookup();
    const result = formatScheduledTransactionForOutput(stx, lookups);

    expect(result.category_group_id).toBeNull();
    expect(result.category_group_name).toBeNull();
  });

  it("converts amount and produces amount_display", () => {
    const stx = createMockScheduledTransaction({ amount: -100000 });
    const lookups = createMockNameLookup();
    const format = createMockCurrencyFormat();
    const result = formatScheduledTransactionForOutput(stx, lookups, format);

    expect(result.amount).toBe(-100);
    expect(result.amount_display).toBe("-$100.00");
  });

  it("falls back to null for missing lookup IDs", () => {
    const stx = createMockScheduledTransaction({
      payee_id: null,
      category_id: null,
    });
    const lookups = createMockNameLookup();
    const result = formatScheduledTransactionForOutput(stx, lookups);

    expect(result.payee_name).toBeNull();
    expect(result.category_name).toBeNull();
  });
});
