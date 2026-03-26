import type { UndoEntry } from "./undo/types.js";
import type { CurrencyFormatLike } from "./ynab/format.js";
import type { NameLookup } from "./ynab/types.js";

export function createMockUndoEntry(
  overrides: Partial<UndoEntry> & {
    undo_action?: Partial<UndoEntry["undo_action"]>;
  } = {},
): UndoEntry {
  return {
    id: "budget-1::1700000000000::abcd1234",
    session_id: "session-1",
    budget_id: "budget-1",
    timestamp: "2024-01-15T10:00:00.000Z",
    operation: "update_transaction",
    description: "Updated transaction tx-1.",
    status: "active",
    ...overrides,
    undo_action: {
      type: "update",
      entity_type: "transaction",
      entity_id: "tx-1",
      expected_state: { id: "tx-1", amount: 5000 },
      restore_state: { id: "tx-1", amount: 3000 },
      ...overrides.undo_action,
    },
  };
}

export function createMockTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: "tx-1",
    account_id: "acc-1",
    date: "2024-01-15",
    amount: -50000,
    payee_id: "payee-1",
    category_id: "cat-1",
    memo: "Groceries",
    cleared: "cleared" as const,
    approved: true,
    flag_color: null as string | null,
    ...overrides,
  };
}

export function createMockScheduledTransaction(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "stx-1",
    account_id: "acc-1",
    date_first: "2024-01-01",
    date_next: "2024-02-01",
    frequency: "monthly",
    amount: -100000,
    payee_id: "payee-1",
    category_id: "cat-1",
    memo: "Rent",
    flag_color: null as string | null,
    ...overrides,
  };
}

export function createMockNameLookup(
  overrides: Partial<NameLookup> = {},
): NameLookup {
  return {
    accountById: overrides.accountById ?? new Map([["acc-1", "Checking"]]),
    categoryById: overrides.categoryById ?? new Map([["cat-1", "Groceries"]]),
    payeeById: overrides.payeeById ?? new Map([["payee-1", "Supermarket"]]),
  };
}

export function createMockCurrencyFormat(
  overrides: Partial<CurrencyFormatLike> = {},
): CurrencyFormatLike {
  return {
    currency_symbol: "$",
    decimal_digits: 2,
    decimal_separator: ".",
    group_separator: ",",
    symbol_first: true,
    display_symbol: true,
    ...overrides,
  };
}
