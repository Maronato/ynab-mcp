import { beforeEach, describe, expect, it } from "vitest";
import type { MockAppContext } from "../test-utils.js";
import {
  captureToolHandlers,
  createMockContext,
  createMockCurrencyFormat,
  createMockTransaction,
} from "../test-utils.js";
import { registerRecurringTools } from "./recurring.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

let ctx: MockAppContext;
let handler: ToolHandler;

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function setupDefaults() {
  ctx.ynabClient.getBudgetSettings.mockResolvedValue({
    currency_format: createMockCurrencyFormat(),
  });
  ctx.ynabClient.getNameLookup.mockResolvedValue({
    accountById: new Map([["acc-1", "Checking"]]),
    categoryById: new Map([
      [
        "cat-subs",
        { name: "Subscriptions", group_id: "group-1", group_name: "Bills" },
      ],
    ]),
    payeeById: new Map([
      ["payee-netflix", "Netflix"],
      ["payee-spotify", "Spotify"],
      ["payee-gym", "Planet Fitness"],
      ["payee-random", "Random Store"],
    ]),
  });
  ctx.ynabClient.getScheduledTransactions.mockResolvedValue([]);
}

/**
 * Build a list of monthly transactions for a payee, starting from a given
 * date and repeating `count` times on roughly the same day each month.
 */
function buildMonthlyTransactions(opts: {
  payeeId: string;
  accountId?: string;
  categoryId?: string;
  amount: number;
  startDate: string;
  count: number;
  idPrefix?: string;
}) {
  const txs = [];
  const start = new Date(opts.startDate);
  for (let i = 0; i < opts.count; i++) {
    const d = new Date(start);
    d.setMonth(d.getMonth() + i);
    const dateStr = d.toISOString().slice(0, 10);
    txs.push(
      createMockTransaction({
        id: `${opts.idPrefix ?? opts.payeeId}-${i}`,
        payee_id: opts.payeeId,
        account_id: opts.accountId ?? "acc-1",
        category_id: opts.categoryId ?? "cat-subs",
        amount: opts.amount,
        date: dateStr,
      }),
    );
  }
  return txs;
}

beforeEach(() => {
  ctx = createMockContext();
  const tools = captureToolHandlers(registerRecurringTools, ctx);
  handler = tools.detect_recurring_charges;
  setupDefaults();
});

describe("detect_recurring_charges", () => {
  describe("monthly recurrence detection", () => {
    it("detects a monthly recurring charge from 3+ consistent transactions", async () => {
      const netflixTxs = buildMonthlyTransactions({
        payeeId: "payee-netflix",
        amount: -15990,
        startDate: "2025-10-15",
        count: 5,
      });
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(netflixTxs);

      const result = parseResult(
        await handler({ history_months: 6, min_occurrences: 3 }),
      );

      expect(result.subscription_count).toBe(1);
      const sub = result.subscriptions[0];
      expect(sub.payee_name).toBe("Netflix");
      expect(sub.occurrence_count).toBe(5);
      expect(sub.detected_frequency_label).toBe("monthly");
      expect(sub.detected_frequency_days).toBeGreaterThanOrEqual(28);
      expect(sub.detected_frequency_days).toBeLessThanOrEqual(31);
      expect(sub.current_amount).toBeCloseTo(15.99, 1);
      expect(sub.price_changed).toBe(false);
    });

    it("detects multiple subscriptions and sorts by monthly equivalent descending", async () => {
      const netflixTxs = buildMonthlyTransactions({
        payeeId: "payee-netflix",
        amount: -15990,
        startDate: "2025-10-15",
        count: 4,
      });
      const gymTxs = buildMonthlyTransactions({
        payeeId: "payee-gym",
        amount: -49990,
        startDate: "2025-10-01",
        count: 4,
      });
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue([
        ...netflixTxs,
        ...gymTxs,
      ]);

      const result = parseResult(
        await handler({ history_months: 6, min_occurrences: 3 }),
      );

      expect(result.subscription_count).toBe(2);
      // Gym ($49.99/month) should appear before Netflix ($15.99/month)
      expect(result.subscriptions[0].payee_name).toBe("Planet Fitness");
      expect(result.subscriptions[1].payee_name).toBe("Netflix");
    });
  });

  describe("frequency labels", () => {
    it("labels weekly charges correctly", async () => {
      // Build weekly transactions (every 7 days)
      const txs = [];
      const start = new Date("2025-12-01");
      for (let i = 0; i < 6; i++) {
        const d = new Date(start);
        d.setDate(d.getDate() + i * 7);
        txs.push(
          createMockTransaction({
            id: `weekly-${i}`,
            payee_id: "payee-spotify",
            account_id: "acc-1",
            category_id: "cat-subs",
            amount: -5000,
            date: d.toISOString().slice(0, 10),
          }),
        );
      }
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(txs);

      const result = parseResult(
        await handler({ history_months: 6, min_occurrences: 3 }),
      );

      expect(result.subscription_count).toBe(1);
      expect(result.subscriptions[0].detected_frequency_label).toBe("weekly");
    });

    it("labels annual charges correctly", async () => {
      // Build annual transactions (every ~365 days)
      const txs = [
        createMockTransaction({
          id: "annual-0",
          payee_id: "payee-spotify",
          account_id: "acc-1",
          category_id: "cat-subs",
          amount: -120000,
          date: "2023-03-15",
        }),
        createMockTransaction({
          id: "annual-1",
          payee_id: "payee-spotify",
          account_id: "acc-1",
          category_id: "cat-subs",
          amount: -120000,
          date: "2024-03-14",
        }),
        createMockTransaction({
          id: "annual-2",
          payee_id: "payee-spotify",
          account_id: "acc-1",
          category_id: "cat-subs",
          amount: -120000,
          date: "2025-03-15",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(txs);

      const result = parseResult(
        await handler({ history_months: 36, min_occurrences: 3 }),
      );

      expect(result.subscription_count).toBe(1);
      expect(result.subscriptions[0].detected_frequency_label).toBe("annual");
    });
  });

  describe("price changes", () => {
    it("detects a price increase between the last two charges", async () => {
      const txs = buildMonthlyTransactions({
        payeeId: "payee-netflix",
        amount: -15990,
        startDate: "2025-09-15",
        count: 4,
      });
      // Override last transaction to a higher amount
      txs[txs.length - 1] = createMockTransaction({
        id: "payee-netflix-3",
        payee_id: "payee-netflix",
        account_id: "acc-1",
        category_id: "cat-subs",
        amount: -17990,
        date: "2025-12-15",
      });
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(txs);

      const result = parseResult(
        await handler({ history_months: 6, min_occurrences: 3 }),
      );

      const sub = result.subscriptions[0];
      expect(sub.price_changed).toBe(true);
      expect(sub.price_change_percent).toBeGreaterThan(0);
      expect(sub.current_amount).toBeCloseTo(17.99, 1);
      expect(sub.previous_amount).toBeCloseTo(15.99, 1);
    });

    it("does not flag price change when amounts are the same", async () => {
      const txs = buildMonthlyTransactions({
        payeeId: "payee-netflix",
        amount: -15990,
        startDate: "2025-10-15",
        count: 4,
      });
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(txs);

      const result = parseResult(
        await handler({ history_months: 6, min_occurrences: 3 }),
      );

      expect(result.subscriptions[0].price_changed).toBe(false);
      expect(result.subscriptions[0].price_change_percent).toBeNull();
    });
  });

  describe("overdue detection", () => {
    it("flags a charge as overdue when the expected date has passed", async () => {
      // Build transactions far enough in the past that next expected is before today
      const txs = buildMonthlyTransactions({
        payeeId: "payee-netflix",
        amount: -15990,
        startDate: "2025-06-15",
        count: 3,
      });
      // Last charge was 2025-08-15, next expected ~2025-09-15, well before today (2026-03-28)
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(txs);

      const result = parseResult(
        await handler({ history_months: 12, min_occurrences: 3 }),
      );

      const sub = result.subscriptions[0];
      expect(sub.is_overdue).toBe(true);
      expect(sub.days_overdue).toBeGreaterThan(0);
    });

    it("does not flag recent charges as overdue", async () => {
      // Build transactions up to close to today
      const now = new Date();
      const txs = [];
      for (let i = 3; i >= 0; i--) {
        const d = new Date(now);
        d.setMonth(d.getMonth() - i);
        txs.push(
          createMockTransaction({
            id: `recent-${i}`,
            payee_id: "payee-netflix",
            account_id: "acc-1",
            category_id: "cat-subs",
            amount: -15990,
            date: d.toISOString().slice(0, 10),
          }),
        );
      }
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(txs);

      const result = parseResult(
        await handler({ history_months: 6, min_occurrences: 3 }),
      );

      const sub = result.subscriptions[0];
      // Next expected is about 1 month from now, so not overdue
      expect(sub.is_overdue).toBe(false);
      expect(sub.days_overdue).toBe(0);
    });
  });

  describe("scheduled transaction matching", () => {
    it("marks a subscription as matched when a scheduled transaction exists for the same payee", async () => {
      const txs = buildMonthlyTransactions({
        payeeId: "payee-netflix",
        amount: -15990,
        startDate: "2025-10-15",
        count: 4,
      });
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(txs);
      ctx.ynabClient.getScheduledTransactions.mockResolvedValue([
        {
          id: "stx-netflix",
          payee_id: "payee-netflix",
          amount: -15990,
          account_id: "acc-1",
          date_first: "2025-10-15",
          date_next: "2026-04-15",
          frequency: "monthly",
        },
      ]);

      const result = parseResult(
        await handler({
          history_months: 6,
          min_occurrences: 3,
          include_matched: true,
        }),
      );

      const sub = result.subscriptions[0];
      expect(sub.has_scheduled_transaction).toBe(true);
      expect(sub.scheduled_transaction_id).toBe("stx-netflix");
    });

    it("excludes matched subscriptions when include_matched is false", async () => {
      const txs = buildMonthlyTransactions({
        payeeId: "payee-netflix",
        amount: -15990,
        startDate: "2025-10-15",
        count: 4,
      });
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(txs);
      ctx.ynabClient.getScheduledTransactions.mockResolvedValue([
        {
          id: "stx-netflix",
          payee_id: "payee-netflix",
          amount: -15990,
          account_id: "acc-1",
          date_first: "2025-10-15",
          date_next: "2026-04-15",
          frequency: "monthly",
        },
      ]);

      const result = parseResult(
        await handler({
          history_months: 6,
          min_occurrences: 3,
          include_matched: false,
        }),
      );

      expect(result.subscription_count).toBe(0);
      expect(result.subscriptions).toHaveLength(0);
    });
  });

  describe("create_scheduled_actions", () => {
    it("generates actions for unmatched subscriptions", async () => {
      const txs = buildMonthlyTransactions({
        payeeId: "payee-netflix",
        amount: -15990,
        startDate: "2025-10-15",
        count: 4,
      });
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(txs);

      const result = parseResult(
        await handler({ history_months: 6, min_occurrences: 3 }),
      );

      expect(result.unmatched_count).toBe(1);
      expect(result.create_scheduled_actions).toHaveLength(1);
      const action = result.create_scheduled_actions[0];
      expect(action.payee_id).toBe("payee-netflix");
      expect(action.account_id).toBe("acc-1");
      expect(action.category_id).toBe("cat-subs");
      expect(action.frequency).toBe("monthly");
      // Amount should be negative (an outflow)
      expect(action.amount).toBeLessThan(0);
      expect(action.memo).toContain("monthly");
    });

    it("does not generate actions for matched subscriptions", async () => {
      const txs = buildMonthlyTransactions({
        payeeId: "payee-netflix",
        amount: -15990,
        startDate: "2025-10-15",
        count: 4,
      });
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(txs);
      ctx.ynabClient.getScheduledTransactions.mockResolvedValue([
        {
          id: "stx-netflix",
          payee_id: "payee-netflix",
          amount: -15990,
          account_id: "acc-1",
          date_first: "2025-10-15",
          date_next: "2026-04-15",
          frequency: "monthly",
        },
      ]);

      const result = parseResult(
        await handler({ history_months: 6, min_occurrences: 3 }),
      );

      expect(result.create_scheduled_actions).toHaveLength(0);
    });
  });

  describe("filtering", () => {
    it("skips inflows (positive amounts)", async () => {
      const txs = [
        ...buildMonthlyTransactions({
          payeeId: "payee-netflix",
          amount: -15990,
          startDate: "2025-10-15",
          count: 3,
        }),
        // Add some inflow transactions for the same payee (refunds)
        createMockTransaction({
          id: "refund-1",
          payee_id: "payee-netflix",
          amount: 15990,
          date: "2025-11-20",
        }),
        createMockTransaction({
          id: "refund-2",
          payee_id: "payee-netflix",
          amount: 15990,
          date: "2025-12-20",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(txs);

      const result = parseResult(
        await handler({ history_months: 6, min_occurrences: 3 }),
      );

      // Should only count the 3 outflows
      expect(result.subscriptions[0].occurrence_count).toBe(3);
    });

    it("skips transfers", async () => {
      const transferTxs = buildMonthlyTransactions({
        payeeId: "payee-netflix",
        amount: -50000,
        startDate: "2025-10-15",
        count: 4,
      }).map((tx) => ({
        ...tx,
        transfer_account_id: "acc-savings",
      }));
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transferTxs);

      const result = parseResult(
        await handler({ history_months: 6, min_occurrences: 3 }),
      );

      expect(result.subscription_count).toBe(0);
    });

    it("requires min_occurrences to be met", async () => {
      // Only 2 transactions, but min_occurrences=3
      const txs = buildMonthlyTransactions({
        payeeId: "payee-netflix",
        amount: -15990,
        startDate: "2025-11-15",
        count: 2,
      });
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(txs);

      const result = parseResult(
        await handler({ history_months: 6, min_occurrences: 3 }),
      );

      expect(result.subscription_count).toBe(0);
    });
  });

  describe("irregular timing", () => {
    it("does not flag payees with inconsistent intervals as recurring", async () => {
      // Transactions with wildly varying intervals (CV >= 0.3)
      const txs = [
        createMockTransaction({
          id: "irregular-0",
          payee_id: "payee-random",
          account_id: "acc-1",
          category_id: "cat-subs",
          amount: -20000,
          date: "2025-08-01",
        }),
        createMockTransaction({
          id: "irregular-1",
          payee_id: "payee-random",
          account_id: "acc-1",
          category_id: "cat-subs",
          amount: -25000,
          date: "2025-08-10", // 9 days later
        }),
        createMockTransaction({
          id: "irregular-2",
          payee_id: "payee-random",
          account_id: "acc-1",
          category_id: "cat-subs",
          amount: -18000,
          date: "2025-09-20", // 41 days later
        }),
        createMockTransaction({
          id: "irregular-3",
          payee_id: "payee-random",
          account_id: "acc-1",
          category_id: "cat-subs",
          amount: -22000,
          date: "2025-10-02", // 12 days later
        }),
        createMockTransaction({
          id: "irregular-4",
          payee_id: "payee-random",
          account_id: "acc-1",
          category_id: "cat-subs",
          amount: -30000,
          date: "2025-12-25", // 84 days later
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(txs);

      const result = parseResult(
        await handler({ history_months: 6, min_occurrences: 3 }),
      );

      expect(result.subscription_count).toBe(0);
    });
  });

  describe("summary values", () => {
    it("computes total_monthly_cost across all detected subscriptions", async () => {
      const netflixTxs = buildMonthlyTransactions({
        payeeId: "payee-netflix",
        amount: -15990,
        startDate: "2025-10-15",
        count: 4,
      });
      const gymTxs = buildMonthlyTransactions({
        payeeId: "payee-gym",
        amount: -49990,
        startDate: "2025-10-01",
        count: 4,
      });
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue([
        ...netflixTxs,
        ...gymTxs,
      ]);

      const result = parseResult(
        await handler({ history_months: 6, min_occurrences: 3 }),
      );

      // Total monthly cost = sum of monthly_equivalent for all detected subs
      expect(result.total_monthly_cost).toBeGreaterThan(0);
      const sumOfEquivs = result.subscriptions.reduce(
        (s: number, sub: { monthly_equivalent: number }) =>
          s + sub.monthly_equivalent,
        0,
      );
      expect(result.total_monthly_cost).toBeCloseTo(sumOfEquivs, 0);
    });

    it("returns budget_id in the result", async () => {
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue([]);

      const result = parseResult(
        await handler({ budget_id: "my-budget", history_months: 6 }),
      );

      expect(result.budget_id).toBe("my-budget");
    });
  });

  describe("empty data", () => {
    it("returns zero subscriptions when no transactions exist", async () => {
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue([]);

      const result = parseResult(await handler({ history_months: 6 }));

      expect(result.subscription_count).toBe(0);
      expect(result.subscriptions).toHaveLength(0);
      expect(result.create_scheduled_actions).toHaveLength(0);
      expect(result.total_monthly_cost).toBe(0);
    });
  });
});
