import { beforeEach, describe, expect, it } from "vitest";
import type { MockAppContext } from "../test-utils.js";
import {
  captureToolHandlers,
  createMockContext,
  createMockTransaction,
} from "../test-utils.js";
import { registerAnalysisTools } from "./analysis.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

let ctx: MockAppContext;
let handler: ToolHandler;

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  ctx = createMockContext();
  const tools = captureToolHandlers(registerAnalysisTools, ctx);
  handler = tools.get_spending_analysis;
});

function setupTransactions() {
  const transactions = [
    createMockTransaction({
      id: "t1",
      amount: -10000,
      category_id: "cat-1",
      payee_id: "payee-1",
      account_id: "acc-1",
    }),
    createMockTransaction({
      id: "t2",
      amount: -30000,
      category_id: "cat-1",
      payee_id: "payee-2",
      account_id: "acc-1",
    }),
    createMockTransaction({
      id: "t3",
      amount: -20000,
      category_id: "cat-2",
      payee_id: "payee-1",
      account_id: "acc-2",
    }),
    createMockTransaction({
      id: "t-income",
      amount: 500000,
      category_id: "cat-1",
      payee_id: "payee-1",
      account_id: "acc-1",
    }),
  ];
  ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);
  ctx.ynabClient.getNameLookup.mockResolvedValue({
    accountById: new Map(),
    categoryById: new Map([
      [
        "cat-1",
        { name: "Groceries", group_id: "group-1", group_name: "Everyday" },
      ],
      ["cat-2", { name: "Rent", group_id: "group-2", group_name: "Bills" }],
    ]),
    payeeById: new Map([
      ["payee-1", "Store A"],
      ["payee-2", "Store B"],
    ]),
  });
}

describe("get_spending_analysis", () => {
  describe("aggregation logic", () => {
    it("skips positive-amount transactions (income)", async () => {
      setupTransactions();
      const result = parseResult(
        await handler({ since_date: "2024-01-01", group_by: "category" }),
      );

      // 10000 + 30000 + 20000 = 60000 milliunits = 60.0
      expect(result.total_spending_milliunits).toBe(60000);
      expect(result.transaction_count).toBe(3);
    });

    it("sums absolute values of negative amounts", async () => {
      setupTransactions();
      const result = parseResult(
        await handler({ since_date: "2024-01-01", group_by: "category" }),
      );

      expect(result.total_spending).toBe(60);
    });
  });

  describe("grouping", () => {
    it("groups by category", async () => {
      setupTransactions();
      const result = parseResult(
        await handler({ since_date: "2024-01-01", group_by: "category" }),
      );

      expect(result.by_category).toHaveLength(2);
      expect(result.by_payee).toBeUndefined();
      // cat-1: 10000 + 30000 = 40000, cat-2: 20000
      expect(result.by_category[0].name).toBe("Groceries");
      expect(result.by_category[0].total_milliunits).toBe(40000);
      expect(result.by_category[0].category_group_id).toBe("group-1");
      expect(result.by_category[0].category_group_name).toBe("Everyday");
    });

    it("groups by payee", async () => {
      setupTransactions();
      const result = parseResult(
        await handler({ since_date: "2024-01-01", group_by: "payee" }),
      );

      expect(result.by_payee).toHaveLength(2);
      expect(result.by_category).toBeUndefined();
      // payee-1: 10000 + 20000 = 30000, payee-2: 30000
      const sorted = result.by_payee.map((e: { name: string }) => e.name);
      expect(sorted).toContain("Store A");
      expect(sorted).toContain("Store B");
    });

    it("groups by both when group_by is 'both'", async () => {
      setupTransactions();
      const result = parseResult(
        await handler({ since_date: "2024-01-01", group_by: "both" }),
      );

      expect(result.by_category).toBeDefined();
      expect(result.by_payee).toBeDefined();
    });

    it("maps null category_id to 'uncategorized'", async () => {
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue([
        createMockTransaction({ amount: -5000, category_id: null }),
      ]);
      ctx.ynabClient.getNameLookup.mockResolvedValue({
        accountById: new Map(),
        categoryById: new Map(),
        payeeById: new Map(),
      });

      const result = parseResult(
        await handler({ since_date: "2024-01-01", group_by: "category" }),
      );

      expect(result.by_category[0].id).toBe("uncategorized");
      expect(result.by_category[0].name).toBe("Uncategorized");
    });

    it("maps null payee_id to 'no_payee'", async () => {
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue([
        createMockTransaction({ amount: -5000, payee_id: null }),
      ]);
      ctx.ynabClient.getNameLookup.mockResolvedValue({
        accountById: new Map(),
        categoryById: new Map(),
        payeeById: new Map(),
      });

      const result = parseResult(
        await handler({ since_date: "2024-01-01", group_by: "payee" }),
      );

      expect(result.by_payee[0].id).toBe("no_payee");
      expect(result.by_payee[0].name).toBe("No Payee");
    });
  });

  describe("filtering", () => {
    it("filters by account_ids", async () => {
      setupTransactions();
      const result = parseResult(
        await handler({
          since_date: "2024-01-01",
          group_by: "category",
          account_ids: ["acc-1"],
        }),
      );

      // Only t1 and t2 (acc-1), not t3 (acc-2)
      expect(result.transaction_count).toBe(2);
      expect(result.total_spending_milliunits).toBe(40000);
    });

    it("filters by category_ids", async () => {
      setupTransactions();
      const result = parseResult(
        await handler({
          since_date: "2024-01-01",
          group_by: "category",
          category_ids: ["cat-2"],
        }),
      );

      expect(result.transaction_count).toBe(1);
      expect(result.total_spending_milliunits).toBe(20000);
    });
  });

  describe("top-N and naming", () => {
    it("returns only top_n entries sorted by total descending", async () => {
      setupTransactions();
      const result = parseResult(
        await handler({
          since_date: "2024-01-01",
          group_by: "category",
          top_n: 1,
        }),
      );

      expect(result.by_category).toHaveLength(1);
      expect(result.by_category[0].name).toBe("Groceries");
    });

    it("falls back to 'Unknown Category' for unknown IDs", async () => {
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue([
        createMockTransaction({ amount: -5000, category_id: "unknown-cat" }),
      ]);
      ctx.ynabClient.getNameLookup.mockResolvedValue({
        accountById: new Map(),
        categoryById: new Map(),
        payeeById: new Map(),
      });

      const result = parseResult(
        await handler({ since_date: "2024-01-01", group_by: "category" }),
      );

      expect(result.by_category[0].name).toBe("Unknown Category");
    });
  });
});
