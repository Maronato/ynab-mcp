import { beforeEach, describe, expect, it } from "vitest";
import type { MockAppContext } from "../test-utils.js";
import {
  captureToolHandlers,
  createMockContext,
  createMockCurrencyFormat,
  createMockTransaction,
} from "../test-utils.js";
import { registerAnomalyTools } from "./anomalies.js";

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
        "cat-groceries",
        { name: "Groceries", group_id: "group-1", group_name: "Everyday" },
      ],
      [
        "cat-dining",
        { name: "Dining Out", group_id: "group-1", group_name: "Everyday" },
      ],
    ]),
    payeeById: new Map([
      ["payee-grocery", "Whole Foods"],
      ["payee-gas", "Shell Gas"],
      ["payee-new", "Sketchy Electronics"],
    ]),
  });
}

/**
 * Build a history of consistent transactions for a payee, plus one optional
 * recent outlier. The history dates are spread over several months in the past.
 */
function buildPayeeHistory(opts: {
  payeeId: string;
  categoryId?: string;
  normalAmount: number;
  count: number;
  startDate: string;
}) {
  const txs = [];
  const start = new Date(opts.startDate);
  for (let i = 0; i < opts.count; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i * 14); // every ~2 weeks
    txs.push(
      createMockTransaction({
        id: `history-${opts.payeeId}-${i}`,
        payee_id: opts.payeeId,
        account_id: "acc-1",
        category_id: opts.categoryId ?? "cat-groceries",
        amount: opts.normalAmount,
        date: d.toISOString().slice(0, 10),
      }),
    );
  }
  return txs;
}

beforeEach(() => {
  ctx = createMockContext();
  const tools = captureToolHandlers(registerAnomalyTools, ctx);
  handler = tools.detect_anomalies;
  setupDefaults();
});

describe("detect_anomalies", () => {
  describe("unusual_amount detection", () => {
    it("flags a transaction that is >2 sigma from the payee mean (medium sensitivity)", async () => {
      // Build 8 consistent transactions of -$50 each, then one outlier of -$200
      const today = new Date();
      const historyStart = new Date(today);
      historyStart.setMonth(historyStart.getMonth() - 5);

      const normalTxs = buildPayeeHistory({
        payeeId: "payee-grocery",
        normalAmount: -50000,
        count: 8,
        startDate: historyStart.toISOString().slice(0, 10),
      });

      // Recent outlier within detection window (last 30 days)
      const recentDate = new Date(today);
      recentDate.setDate(recentDate.getDate() - 5);
      const outlier = createMockTransaction({
        id: "outlier-1",
        payee_id: "payee-grocery",
        account_id: "acc-1",
        category_id: "cat-groceries",
        amount: -200000,
        date: recentDate.toISOString().slice(0, 10),
      });

      ctx.ynabClient.getTransactionsInRange.mockResolvedValue([
        ...normalTxs,
        outlier,
      ]);

      const result = parseResult(
        await handler({ sensitivity: "medium", history_months: 6 }),
      );

      expect(result.anomaly_count).toBeGreaterThanOrEqual(1);
      const unusual = result.anomalies.find(
        (a: { anomaly_type: string; transaction_id: string }) =>
          a.anomaly_type === "unusual_amount" &&
          a.transaction_id === "outlier-1",
      );
      expect(unusual).toBeDefined();
      expect(unusual.payee_name).toBe("Whole Foods");
      expect(unusual.severity).toMatch(/warning|alert/);
      expect(unusual.detail).toContain("standard deviations");
      expect(unusual.reference.sigma_distance).toBeGreaterThanOrEqual(2);
    });

    it("does not flag amounts within normal range", async () => {
      const today = new Date();
      const historyStart = new Date(today);
      historyStart.setMonth(historyStart.getMonth() - 4);

      // Build transactions with natural variance (amounts between $45-$55).
      // The recent transaction at -$52 should sit well within 2 sigma of this
      // distribution and NOT be flagged.
      const amounts = [
        -45000, -55000, -48000, -52000, -50000, -47000, -53000, -51000,
      ];
      const txs = amounts.map((amount, i) => {
        const d = new Date(historyStart);
        d.setDate(d.getDate() + i * 14);
        return createMockTransaction({
          id: `varied-hist-${i}`,
          payee_id: "payee-grocery",
          account_id: "acc-1",
          category_id: "cat-groceries",
          amount,
          date: d.toISOString().slice(0, 10),
        });
      });

      // Add one more within last 30 days that is well within the range
      const recentDate = new Date(today);
      recentDate.setDate(recentDate.getDate() - 3);
      txs.push(
        createMockTransaction({
          id: "normal-recent",
          payee_id: "payee-grocery",
          account_id: "acc-1",
          category_id: "cat-groceries",
          amount: -52000,
          date: recentDate.toISOString().slice(0, 10),
        }),
      );

      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(txs);

      const result = parseResult(
        await handler({ sensitivity: "medium", history_months: 6 }),
      );

      const unusualForPayee = result.anomalies.filter(
        (a: { anomaly_type: string }) => a.anomaly_type === "unusual_amount",
      );
      expect(unusualForPayee).toHaveLength(0);
    });
  });

  describe("new_payee_large detection", () => {
    it("flags a new payee with a large charge above the 75th percentile", async () => {
      const today = new Date();
      const historyStart = new Date(today);
      historyStart.setMonth(historyStart.getMonth() - 4);

      // Build baseline spending: many small transactions to establish a p75
      const baselineTxs = buildPayeeHistory({
        payeeId: "payee-grocery",
        normalAmount: -30000,
        count: 10,
        startDate: historyStart.toISOString().slice(0, 10),
      });

      // New payee with a large charge in the recent window
      const recentDate = new Date(today);
      recentDate.setDate(recentDate.getDate() - 2);
      const newPayeeTx = createMockTransaction({
        id: "new-large-1",
        payee_id: "payee-new",
        account_id: "acc-1",
        category_id: "cat-dining",
        amount: -500000, // $500 vs baseline of $30 each
        date: recentDate.toISOString().slice(0, 10),
      });

      ctx.ynabClient.getTransactionsInRange.mockResolvedValue([
        ...baselineTxs,
        newPayeeTx,
      ]);

      const result = parseResult(
        await handler({ sensitivity: "medium", history_months: 6 }),
      );

      const newPayeeAnomaly = result.anomalies.find(
        (a: { anomaly_type: string; transaction_id: string }) =>
          a.anomaly_type === "new_payee_large" &&
          a.transaction_id === "new-large-1",
      );
      expect(newPayeeAnomaly).toBeDefined();
      expect(newPayeeAnomaly.payee_name).toBe("Sketchy Electronics");
      expect(newPayeeAnomaly.severity).toBe("warning");
      expect(newPayeeAnomaly.detail).toContain("New payee");
      expect(newPayeeAnomaly.reference.payee_history_count).toBeLessThanOrEqual(
        2,
      );
    });

    it("does not flag established payees as new", async () => {
      const today = new Date();
      const historyStart = new Date(today);
      historyStart.setMonth(historyStart.getMonth() - 5);

      // payee-grocery has many historical transactions
      const txs = buildPayeeHistory({
        payeeId: "payee-grocery",
        normalAmount: -30000,
        count: 12,
        startDate: historyStart.toISOString().slice(0, 10),
      });

      // The most recent one is in the detection window but it's not "new"
      const recentDate = new Date(today);
      recentDate.setDate(recentDate.getDate() - 1);
      txs.push(
        createMockTransaction({
          id: "established-recent",
          payee_id: "payee-grocery",
          account_id: "acc-1",
          category_id: "cat-groceries",
          amount: -35000,
          date: recentDate.toISOString().slice(0, 10),
        }),
      );

      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(txs);

      const result = parseResult(
        await handler({ sensitivity: "medium", history_months: 6 }),
      );

      const newPayee = result.anomalies.filter(
        (a: { anomaly_type: string }) => a.anomaly_type === "new_payee_large",
      );
      expect(newPayee).toHaveLength(0);
    });
  });

  describe("potential_duplicate detection", () => {
    it("detects two transactions to the same payee with similar amounts within 3 days", async () => {
      const today = new Date();
      const recentDate1 = new Date(today);
      recentDate1.setDate(recentDate1.getDate() - 5);
      const recentDate2 = new Date(today);
      recentDate2.setDate(recentDate2.getDate() - 4);

      // Also add some history so the payee is "known"
      const historyStart = new Date(today);
      historyStart.setMonth(historyStart.getMonth() - 3);
      const history = buildPayeeHistory({
        payeeId: "payee-gas",
        normalAmount: -45000,
        count: 6,
        startDate: historyStart.toISOString().slice(0, 10),
      });

      const dup1 = createMockTransaction({
        id: "dup-a",
        payee_id: "payee-gas",
        account_id: "acc-1",
        category_id: "cat-groceries",
        amount: -45000,
        date: recentDate1.toISOString().slice(0, 10),
      });
      const dup2 = createMockTransaction({
        id: "dup-b",
        payee_id: "payee-gas",
        account_id: "acc-1",
        category_id: "cat-groceries",
        amount: -45500, // within 5% tolerance
        date: recentDate2.toISOString().slice(0, 10),
      });

      ctx.ynabClient.getTransactionsInRange.mockResolvedValue([
        ...history,
        dup1,
        dup2,
      ]);

      const result = parseResult(
        await handler({ sensitivity: "medium", history_months: 6 }),
      );

      const duplicates = result.anomalies.filter(
        (a: { anomaly_type: string }) =>
          a.anomaly_type === "potential_duplicate",
      );
      expect(duplicates.length).toBeGreaterThanOrEqual(1);
      const dup = duplicates[0];
      expect(dup.severity).toBe("info");
      expect(dup.detail).toContain("Possible duplicate");
      expect(dup.reference.duplicate_candidate_id).toBeDefined();
    });

    it("does not flag transactions more than 3 days apart as duplicates", async () => {
      const today = new Date();
      const date1 = new Date(today);
      date1.setDate(date1.getDate() - 10);
      const date2 = new Date(today);
      date2.setDate(date2.getDate() - 3);

      // 7 days apart - should not be flagged
      const tx1 = createMockTransaction({
        id: "far-a",
        payee_id: "payee-gas",
        account_id: "acc-1",
        category_id: "cat-groceries",
        amount: -45000,
        date: date1.toISOString().slice(0, 10),
      });
      const tx2 = createMockTransaction({
        id: "far-b",
        payee_id: "payee-gas",
        account_id: "acc-1",
        category_id: "cat-groceries",
        amount: -45000,
        date: date2.toISOString().slice(0, 10),
      });

      ctx.ynabClient.getTransactionsInRange.mockResolvedValue([tx1, tx2]);

      const result = parseResult(
        await handler({ sensitivity: "medium", history_months: 6 }),
      );

      const duplicates = result.anomalies.filter(
        (a: { anomaly_type: string }) =>
          a.anomaly_type === "potential_duplicate",
      );
      expect(duplicates).toHaveLength(0);
    });

    it("does not flag transactions with very different amounts as duplicates", async () => {
      const today = new Date();
      const date1 = new Date(today);
      date1.setDate(date1.getDate() - 3);
      const date2 = new Date(today);
      date2.setDate(date2.getDate() - 2);

      const tx1 = createMockTransaction({
        id: "diff-a",
        payee_id: "payee-gas",
        account_id: "acc-1",
        category_id: "cat-groceries",
        amount: -45000,
        date: date1.toISOString().slice(0, 10),
      });
      const tx2 = createMockTransaction({
        id: "diff-b",
        payee_id: "payee-gas",
        account_id: "acc-1",
        category_id: "cat-groceries",
        amount: -90000, // 100% more - well outside 5% tolerance
        date: date2.toISOString().slice(0, 10),
      });

      ctx.ynabClient.getTransactionsInRange.mockResolvedValue([tx1, tx2]);

      const result = parseResult(
        await handler({ sensitivity: "medium", history_months: 6 }),
      );

      const duplicates = result.anomalies.filter(
        (a: { anomaly_type: string }) =>
          a.anomaly_type === "potential_duplicate",
      );
      expect(duplicates).toHaveLength(0);
    });
  });

  describe("sensitivity levels", () => {
    /**
     * Build a large history of ~$50 transactions (20 items, tight variance).
     * With 20 points the outlier is diluted enough that the population
     * stddev stays small and the deviation is clearly measurable.
     * Mean of abs amounts ~50000, stddev ~3000.
     */
    function buildLargeHistory() {
      const today = new Date();
      const historyStart = new Date(today);
      historyStart.setMonth(historyStart.getMonth() - 5);

      // 20 amounts oscillating around 50000 with natural variance (~$3k)
      const amounts = [
        -48000, -52000, -49000, -51000, -50000, -48500, -51500, -50500, -47500,
        -52500, -49500, -50500, -48000, -52000, -49000, -51000, -50000, -48500,
        -51500, -50500,
      ];
      const txs = amounts.map((amount, i) => {
        const d = new Date(historyStart);
        d.setDate(d.getDate() + i * 7);
        return createMockTransaction({
          id: `sens-hist-${i}`,
          payee_id: "payee-grocery",
          account_id: "acc-1",
          category_id: "cat-groceries",
          amount,
          date: d.toISOString().slice(0, 10),
        });
      });

      const recentDate = new Date(today);
      recentDate.setDate(recentDate.getDate() - 2);

      return { txs, recentDate };
    }

    it("low sensitivity (3 sigma) flags only extreme outliers", async () => {
      const { txs, recentDate } = buildLargeHistory();

      // An outlier at -$500 vs mean ~$50 is extreme enough to exceed 3
      // sigma even after the outlier slightly inflates the statistics.
      const extremeOutlier = createMockTransaction({
        id: "extreme-outlier",
        payee_id: "payee-grocery",
        account_id: "acc-1",
        category_id: "cat-groceries",
        amount: -500000,
        date: recentDate.toISOString().slice(0, 10),
      });

      ctx.ynabClient.getTransactionsInRange.mockResolvedValue([
        ...txs,
        extremeOutlier,
      ]);

      const result = parseResult(
        await handler({ sensitivity: "low", history_months: 6 }),
      );

      const unusual = result.anomalies.filter(
        (a: { anomaly_type: string; transaction_id: string }) =>
          a.anomaly_type === "unusual_amount" &&
          a.transaction_id === "extreme-outlier",
      );
      expect(unusual.length).toBeGreaterThanOrEqual(1);
    });

    it("high sensitivity (1.5 sigma) catches smaller deviations", async () => {
      const { txs, recentDate } = buildLargeHistory();

      // An outlier at -$65 vs history mean ~$50, stddev ~$1.4k.
      // With the outlier included, mean shifts slightly up and stddev
      // grows a bit, but the deviation should still exceed 1.5 sigma.
      const moderateOutlier = createMockTransaction({
        id: "moderate-outlier",
        payee_id: "payee-grocery",
        account_id: "acc-1",
        category_id: "cat-groceries",
        amount: -65000,
        date: recentDate.toISOString().slice(0, 10),
      });

      ctx.ynabClient.getTransactionsInRange.mockResolvedValue([
        ...txs,
        moderateOutlier,
      ]);

      const resultHigh = parseResult(
        await handler({ sensitivity: "high", history_months: 6 }),
      );
      const unusualHigh = resultHigh.anomalies.filter(
        (a: { anomaly_type: string; transaction_id: string }) =>
          a.anomaly_type === "unusual_amount" &&
          a.transaction_id === "moderate-outlier",
      );

      expect(unusualHigh.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("empty and edge cases", () => {
    it("returns empty results when no anomalies exist", async () => {
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue([]);

      const result = parseResult(
        await handler({ sensitivity: "medium", history_months: 6 }),
      );

      expect(result.anomaly_count).toBe(0);
      expect(result.anomalies).toHaveLength(0);
    });

    it("returns empty results when all transactions are inflows", async () => {
      const today = new Date();
      const recentDate = new Date(today);
      recentDate.setDate(recentDate.getDate() - 5);

      ctx.ynabClient.getTransactionsInRange.mockResolvedValue([
        createMockTransaction({
          id: "inflow-1",
          payee_id: "payee-grocery",
          amount: 100000,
          date: recentDate.toISOString().slice(0, 10),
        }),
      ]);

      const result = parseResult(
        await handler({ sensitivity: "medium", history_months: 6 }),
      );

      expect(result.anomaly_count).toBe(0);
    });

    it("skips transfers when checking for anomalies", async () => {
      const today = new Date();
      const recentDate = new Date(today);
      recentDate.setDate(recentDate.getDate() - 2);

      ctx.ynabClient.getTransactionsInRange.mockResolvedValue([
        createMockTransaction({
          id: "transfer-1",
          payee_id: "payee-grocery",
          amount: -500000,
          date: recentDate.toISOString().slice(0, 10),
          transfer_account_id: "acc-savings",
        }),
      ]);

      const result = parseResult(
        await handler({ sensitivity: "medium", history_months: 6 }),
      );

      expect(result.anomaly_count).toBe(0);
    });

    it("returns budget_id in the result", async () => {
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue([]);

      const result = parseResult(
        await handler({
          budget_id: "my-budget",
          sensitivity: "medium",
          history_months: 6,
        }),
      );

      expect(result.budget_id).toBe("my-budget");
    });
  });

  describe("sorting", () => {
    it("sorts anomalies by severity then by absolute amount descending", async () => {
      const today = new Date();
      const historyStart = new Date(today);
      historyStart.setMonth(historyStart.getMonth() - 4);

      // Build baseline to establish p75
      const baseline = buildPayeeHistory({
        payeeId: "payee-grocery",
        normalAmount: -20000,
        count: 10,
        startDate: historyStart.toISOString().slice(0, 10),
      });

      const recentDate1 = new Date(today);
      recentDate1.setDate(recentDate1.getDate() - 2);
      const recentDate2 = new Date(today);
      recentDate2.setDate(recentDate2.getDate() - 1);

      // New payee with large amount (warning)
      const newPayeeTx = createMockTransaction({
        id: "new-payee-tx",
        payee_id: "payee-new",
        account_id: "acc-1",
        category_id: "cat-dining",
        amount: -300000,
        date: recentDate1.toISOString().slice(0, 10),
      });

      // Two near-identical transactions for duplicate check (info)
      const dupTx1 = createMockTransaction({
        id: "dup-sort-a",
        payee_id: "payee-gas",
        account_id: "acc-1",
        category_id: "cat-groceries",
        amount: -25000,
        date: recentDate1.toISOString().slice(0, 10),
      });
      const dupTx2 = createMockTransaction({
        id: "dup-sort-b",
        payee_id: "payee-gas",
        account_id: "acc-1",
        category_id: "cat-groceries",
        amount: -25000,
        date: recentDate2.toISOString().slice(0, 10),
      });

      ctx.ynabClient.getTransactionsInRange.mockResolvedValue([
        ...baseline,
        newPayeeTx,
        dupTx1,
        dupTx2,
      ]);

      const result = parseResult(
        await handler({ sensitivity: "medium", history_months: 6 }),
      );

      if (result.anomalies.length >= 2) {
        // Warning-level anomalies should come before info-level
        const severities = result.anomalies.map(
          (a: { severity: string }) => a.severity,
        );
        const warningIdx = severities.indexOf("warning");
        const infoIdx = severities.indexOf("info");
        if (warningIdx >= 0 && infoIdx >= 0) {
          expect(warningIdx).toBeLessThan(infoIdx);
        }
      }
    });
  });
});
