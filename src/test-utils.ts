import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { vi } from "vitest";
import type { ZodObject, ZodRawShape, ZodType } from "zod";
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
    payee_name: null as string | null,
    category_id: "cat-1",
    memo: "Groceries",
    cleared: "cleared" as const,
    approved: true,
    flag_color: null as string | null,
    ...overrides,
  };
}

export function createMockSubtransaction(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "sub-1",
    transaction_id: "tx-1",
    amount: -25000,
    memo: null as string | null,
    payee_id: null as string | null,
    payee_name: null as string | null,
    category_id: "cat-1",
    category_name: "Groceries",
    transfer_account_id: null as string | null,
    transfer_transaction_id: null as string | null,
    deleted: false,
    ...overrides,
  };
}

export function createMockSplitTransaction(
  overrides: Record<string, unknown> = {},
) {
  const sub1 = createMockSubtransaction({
    id: "sub-1",
    transaction_id: "tx-split",
    amount: -30000,
    category_id: "cat-1",
    category_name: "Groceries",
  });
  const sub2 = createMockSubtransaction({
    id: "sub-2",
    transaction_id: "tx-split",
    amount: -20000,
    category_id: "cat-2",
    category_name: "Entertainment",
  });
  return {
    id: "tx-split",
    account_id: "acc-1",
    date: "2024-01-15",
    amount: -50000,
    payee_id: "payee-1",
    category_id: "split-cat-id",
    category_name: "Split",
    memo: "Split purchase",
    cleared: "cleared" as const,
    approved: true,
    flag_color: null as string | null,
    subtransactions: [sub1, sub2],
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
    categoryById:
      overrides.categoryById ??
      new Map([
        [
          "cat-1",
          { name: "Groceries", group_id: "group-1", group_name: "Everyday" },
        ],
      ]),
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

// biome-ignore lint/suspicious/noExplicitAny: tool handlers have varying signatures
type ToolHandler = (input: any) => Promise<any>;

type Mock = ReturnType<typeof vi.fn>;

export interface MockAppContext {
  ynabClient: Record<string, Mock>;
  undoEngine: Record<string, Mock>;
  payeeProfileAnalyzer: Record<string, Mock>;
}

export function captureToolHandlers(
  // biome-ignore lint/suspicious/noExplicitAny: test utility accepting any register function
  registerFn: (server: any, context: any) => void,
  context: MockAppContext,
): Record<string, ToolHandler> {
  const handlers: Record<string, ToolHandler> = {};
  const mockServer = {
    registerTool(
      name: string,
      config: { inputSchema?: ZodType | ZodObject<ZodRawShape> } | undefined,
      cb: ToolHandler,
    ) {
      handlers[name] = async (input: unknown) => {
        if (config?.inputSchema) {
          // Validate input through the Zod schema before calling the handler.
          // This catches schema bugs that would otherwise be invisible to tests.
          config.inputSchema.parse(input);
        }
        return cb(input as never);
      };
    },
  } as unknown as McpServer;

  registerFn(mockServer, context);
  return handlers;
}

export function createMockContext(): MockAppContext {
  return {
    ynabClient: {
      resolveBudgetId: vi.fn((id?: string) => id ?? "last-used"),
      resolveRealBudgetId: vi.fn(async (id?: string) => id ?? "budget-1"),
      listBudgets: vi.fn().mockResolvedValue([]),
      getBudgetSettings: vi.fn().mockResolvedValue({ currency_format: {} }),
      getBudgetSummary: vi.fn().mockResolvedValue({}),
      getAccounts: vi.fn().mockResolvedValue([]),
      getCategories: vi.fn().mockResolvedValue([]),
      getMonthSummary: vi.fn().mockResolvedValue({ categories: [] }),
      getPayees: vi.fn().mockResolvedValue([]),
      getNameLookup: vi.fn().mockResolvedValue({
        accountById: new Map(),
        categoryById: new Map(),
        payeeById: new Map(),
      }),
      searchTransactions: vi.fn().mockResolvedValue([]),
      getTransactionById: vi.fn().mockResolvedValue(null),
      createTransactions: vi.fn().mockResolvedValue([]),
      updateTransactions: vi.fn().mockResolvedValue([]),
      replaceTransaction: vi
        .fn()
        .mockResolvedValue({ transaction: {}, previousId: "" }),
      deleteTransaction: vi.fn().mockResolvedValue(null),
      getScheduledTransactionById: vi.fn().mockResolvedValue(null),
      getScheduledTransactions: vi.fn().mockResolvedValue([]),
      createScheduledTransaction: vi.fn().mockResolvedValue({}),
      updateScheduledTransaction: vi.fn().mockResolvedValue({}),
      deleteScheduledTransaction: vi.fn().mockResolvedValue(null),
      setCategoryBudget: vi.fn().mockResolvedValue({}),
      updateCategory: vi.fn().mockResolvedValue({}),
      getCategoryById: vi.fn().mockResolvedValue(null),
      getMonthCategoryById: vi.fn().mockResolvedValue(null),
      getTransactionsInRange: vi.fn().mockResolvedValue([]),
      snapshotTransaction: vi.fn((tx: Record<string, unknown>) => tx),
      snapshotScheduledTransaction: vi.fn((tx: Record<string, unknown>) => tx),
    },
    undoEngine: {
      recordEntries: vi.fn().mockResolvedValue([]),
      listHistory: vi.fn().mockResolvedValue([]),
      undoOperations: vi.fn().mockResolvedValue({ results: [], summary: {} }),
      updateIdMappings: vi.fn().mockResolvedValue(undefined),
    },
    payeeProfileAnalyzer: {
      getProfiles: vi.fn().mockResolvedValue(new Map()),
      invalidate: vi.fn(),
    },
  };
}
