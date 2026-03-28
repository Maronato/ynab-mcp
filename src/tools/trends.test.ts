import { beforeEach, describe, expect, it } from "vitest";
import type { MockAppContext } from "../test-utils.js";
import {
  captureToolHandlers,
  createMockContext,
  createMockCurrencyFormat,
  createMockTransaction,
} from "../test-utils.js";
import { asMilliunits } from "../ynab/format.js";
import { registerTrendTools } from "./trends.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

let ctx: MockAppContext;
let handler: ToolHandler;

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/** Build a YYYY-MM key relative to the current month. offset=0 is the current month, -1 is last month, etc. */
function monthKey(offset: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Build a YYYY-MM-DD date string in a given month offset. */
function dateInMonth(offset: number, day = 15): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + offset, day);
  return d.toISOString().slice(0, 10);
}

function setupLookups() {
  ctx.ynabClient.getNameLookup.mockResolvedValue({
    accountById: new Map([["acc-1", "Checking"]]),
    categoryById: new Map([
      [
        "cat-groceries",
        { name: "Groceries", group_id: "group-food", group_name: "Food" },
      ],
      [
        "cat-dining",
        {
          name: "Dining Out",
          group_id: "group-food",
          group_name: "Food",
        },
      ],
      [
        "cat-rent",
        {
          name: "Rent",
          group_id: "group-housing",
          group_name: "Housing",
        },
      ],
    ]),
    payeeById: new Map([
      ["payee-grocery-store", "Whole Foods"],
      ["payee-restaurant", "Chipotle"],
      ["payee-landlord", "Property Mgmt Co"],
    ]),
  });
  ctx.ynabClient.getBudgetSettings.mockResolvedValue({
    currency_format: createMockCurrencyFormat(),
  });
}

beforeEach(() => {
  ctx = createMockContext();
  const tools = captureToolHandlers(registerTrendTools, ctx);
  handler = tools.get_spending_trends;
});

describe("get_spending_trends", () => {
  describe("monthly totals", () => {
    it("computes monthly totals correctly from transaction data", async () => {
      setupLookups();

      // Two months of transactions: current month and last month
      const transactions = [
        createMockTransaction({
          id: "t1",
          date: dateInMonth(-1, 10),
          amount: -45000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
        createMockTransaction({
          id: "t2",
          date: dateInMonth(-1, 20),
          amount: -32000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
        createMockTransaction({
          id: "t3",
          date: dateInMonth(0, 5),
          amount: -51000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({ months: 2, group_by: "category" }),
      );

      // Last month: 45000 + 32000 = 77000 milliunits = $77.00
      // Current month: 51000 milliunits = $51.00
      expect(result.total_by_month).toHaveLength(2);

      const lastMonth = result.total_by_month.find(
        (m: { month: string }) => m.month === monthKey(-1),
      );
      expect(lastMonth.total).toBe(77);

      const currentMonth = result.total_by_month.find(
        (m: { month: string }) => m.month === monthKey(0),
      );
      expect(currentMonth.total).toBe(51);
    });

    it("fills months with zero when no transactions exist in that month", async () => {
      setupLookups();

      // Only transactions in the current month, none 2 months ago
      const transactions = [
        createMockTransaction({
          id: "t1",
          date: dateInMonth(0, 5),
          amount: -20000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({ months: 3, group_by: "category" }),
      );

      expect(result.total_by_month).toHaveLength(3);

      // The first two months should be zero
      const twoMonthsAgo = result.total_by_month.find(
        (m: { month: string }) => m.month === monthKey(-2),
      );
      expect(twoMonthsAgo.total).toBe(0);

      // Current month should have data
      const current = result.total_by_month.find(
        (m: { month: string }) => m.month === monthKey(0),
      );
      expect(current.total).toBe(20);
    });
  });

  describe("grouping", () => {
    it("groups by category (default)", async () => {
      setupLookups();

      const transactions = [
        createMockTransaction({
          id: "t1",
          date: dateInMonth(0, 5),
          amount: -45000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
        createMockTransaction({
          id: "t2",
          date: dateInMonth(0, 10),
          amount: -120000,
          category_id: "cat-rent",
          payee_id: "payee-landlord",
        }),
        createMockTransaction({
          id: "t3",
          date: dateInMonth(0, 15),
          amount: -15000,
          category_id: "cat-dining",
          payee_id: "payee-restaurant",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({ months: 2, group_by: "category" }),
      );

      expect(result.series).toHaveLength(3);
      // Ranked by total descending: Rent (120k) > Groceries (45k) > Dining (15k)
      expect(result.series[0].name).toBe("Rent");
      expect(result.series[0].total).toBe(120);
      expect(result.series[0].group_name).toBe("Housing");

      expect(result.series[1].name).toBe("Groceries");
      expect(result.series[1].total).toBe(45);

      expect(result.series[2].name).toBe("Dining Out");
      expect(result.series[2].total).toBe(15);
    });

    it("groups by payee", async () => {
      setupLookups();

      const transactions = [
        createMockTransaction({
          id: "t1",
          date: dateInMonth(0, 5),
          amount: -45000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
        createMockTransaction({
          id: "t2",
          date: dateInMonth(0, 10),
          amount: -30000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
        createMockTransaction({
          id: "t3",
          date: dateInMonth(0, 15),
          amount: -15000,
          category_id: "cat-dining",
          payee_id: "payee-restaurant",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({ months: 2, group_by: "payee" }),
      );

      expect(result.series).toHaveLength(2);
      // Whole Foods: 45k + 30k = 75k, Chipotle: 15k
      expect(result.series[0].name).toBe("Whole Foods");
      expect(result.series[0].total).toBe(75);

      expect(result.series[1].name).toBe("Chipotle");
      expect(result.series[1].total).toBe(15);
      // group_name should not appear for payee grouping
      expect(result.series[1].group_name).toBeUndefined();
    });

    it("groups by category_group", async () => {
      setupLookups();

      const transactions = [
        createMockTransaction({
          id: "t1",
          date: dateInMonth(0, 5),
          amount: -45000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
        createMockTransaction({
          id: "t2",
          date: dateInMonth(0, 10),
          amount: -15000,
          category_id: "cat-dining",
          payee_id: "payee-restaurant",
        }),
        createMockTransaction({
          id: "t3",
          date: dateInMonth(0, 15),
          amount: -120000,
          category_id: "cat-rent",
          payee_id: "payee-landlord",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({ months: 2, group_by: "category_group" }),
      );

      expect(result.series).toHaveLength(2);
      // Housing: 120k, Food (Groceries + Dining): 45k + 15k = 60k
      expect(result.series[0].name).toBe("Housing");
      expect(result.series[0].total).toBe(120);

      expect(result.series[1].name).toBe("Food");
      expect(result.series[1].total).toBe(60);
    });
  });

  describe("ranking and top_n", () => {
    it("ranks by total descending and respects top_n limit", async () => {
      setupLookups();

      const transactions = [
        createMockTransaction({
          id: "t1",
          date: dateInMonth(0, 5),
          amount: -10000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
        createMockTransaction({
          id: "t2",
          date: dateInMonth(0, 10),
          amount: -120000,
          category_id: "cat-rent",
          payee_id: "payee-landlord",
        }),
        createMockTransaction({
          id: "t3",
          date: dateInMonth(0, 15),
          amount: -50000,
          category_id: "cat-dining",
          payee_id: "payee-restaurant",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({ months: 2, group_by: "category", top_n: 2 }),
      );

      // Only top 2 by total
      expect(result.series).toHaveLength(2);
      expect(result.series[0].name).toBe("Rent");
      expect(result.series[0].total).toBe(120);
      expect(result.series[1].name).toBe("Dining Out");
      expect(result.series[1].total).toBe(50);
    });

    it("computes average monthly spending per entity", async () => {
      setupLookups();

      // Spread across 3 months
      const transactions = [
        createMockTransaction({
          id: "t1",
          date: dateInMonth(-2, 5),
          amount: -30000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
        createMockTransaction({
          id: "t2",
          date: dateInMonth(-1, 5),
          amount: -60000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
        createMockTransaction({
          id: "t3",
          date: dateInMonth(0, 5),
          amount: -90000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({ months: 3, group_by: "category" }),
      );

      // Total: 30k + 60k + 90k = 180k milliunits = $180
      // Average: 180k / 3 months = 60k = $60
      expect(result.series[0].total).toBe(180);
      expect(result.series[0].average_monthly).toBe(60);
    });
  });

  describe("trend direction", () => {
    it("detects increasing trend when last month exceeds prior average by >5%", async () => {
      setupLookups();

      // Prior months (months -2, -1): $50 each => avg $50
      // Current month: $60 => +20% vs $50
      const transactions = [
        createMockTransaction({
          id: "t1",
          date: dateInMonth(-2, 10),
          amount: -50000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
        createMockTransaction({
          id: "t2",
          date: dateInMonth(-1, 10),
          amount: -50000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
        createMockTransaction({
          id: "t3",
          date: dateInMonth(0, 10),
          amount: -60000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({ months: 3, group_by: "category" }),
      );

      expect(result.series[0].trend_direction).toBe("increasing");
      expect(result.series[0].trend_percent_change).toBe(20);
    });

    it("detects decreasing trend when last month is below prior average by >5%", async () => {
      setupLookups();

      // Prior months: $100 each => avg $100
      // Current month: $50 => -50%
      const transactions = [
        createMockTransaction({
          id: "t1",
          date: dateInMonth(-2, 10),
          amount: -100000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
        createMockTransaction({
          id: "t2",
          date: dateInMonth(-1, 10),
          amount: -100000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
        createMockTransaction({
          id: "t3",
          date: dateInMonth(0, 10),
          amount: -50000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({ months: 3, group_by: "category" }),
      );

      expect(result.series[0].trend_direction).toBe("decreasing");
      expect(result.series[0].trend_percent_change).toBe(-50);
    });

    it("detects stable trend when last month is within 5% of prior average", async () => {
      setupLookups();

      // Prior months: $100 each => avg $100
      // Current month: $102 => +2% (within 5% threshold)
      const transactions = [
        createMockTransaction({
          id: "t1",
          date: dateInMonth(-2, 10),
          amount: -100000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
        createMockTransaction({
          id: "t2",
          date: dateInMonth(-1, 10),
          amount: -100000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
        createMockTransaction({
          id: "t3",
          date: dateInMonth(0, 10),
          amount: -102000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({ months: 3, group_by: "category" }),
      );

      expect(result.series[0].trend_direction).toBe("stable");
      expect(result.series[0].trend_percent_change).toBe(2);
    });
  });

  describe("edge cases", () => {
    it("handles a period with no transactions at all", async () => {
      setupLookups();
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue([]);

      const result = parseResult(
        await handler({ months: 3, group_by: "category" }),
      );

      expect(result.series).toHaveLength(0);
      for (const m of result.total_by_month) {
        expect(m.total).toBe(0);
      }
      expect(result.summary.highest_growth_category).toBeNull();
      expect(result.summary.biggest_reduction_category).toBeNull();
    });

    it("excludes transfers (transactions with transfer_account_id)", async () => {
      setupLookups();

      const transactions = [
        createMockTransaction({
          id: "t-transfer",
          date: dateInMonth(0, 5),
          amount: -200000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
          transfer_account_id: "acc-savings",
        }),
        createMockTransaction({
          id: "t-real",
          date: dateInMonth(0, 10),
          amount: -25000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({ months: 2, group_by: "category" }),
      );

      // Only the non-transfer should be counted
      expect(result.series).toHaveLength(1);
      expect(result.series[0].total).toBe(25);
    });

    it("excludes income (positive amounts)", async () => {
      setupLookups();

      const transactions = [
        createMockTransaction({
          id: "t-income",
          date: dateInMonth(0, 1),
          amount: 500000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
        createMockTransaction({
          id: "t-expense",
          date: dateInMonth(0, 10),
          amount: -18000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({ months: 2, group_by: "category" }),
      );

      const current = result.total_by_month.find(
        (m: { month: string }) => m.month === monthKey(0),
      );
      expect(current.total).toBe(18);
    });

    it("excludes internal master category transactions", async () => {
      ctx.ynabClient.getNameLookup.mockResolvedValue({
        accountById: new Map([["acc-1", "Checking"]]),
        categoryById: new Map([
          [
            "cat-groceries",
            {
              name: "Groceries",
              group_id: "group-food",
              group_name: "Food",
            },
          ],
          [
            "cat-internal",
            {
              name: "To Be Budgeted",
              group_id: "group-internal",
              group_name: "Internal Master Category",
            },
          ],
        ]),
        payeeById: new Map([["payee-1", "Store"]]),
      });
      ctx.ynabClient.getBudgetSettings.mockResolvedValue({
        currency_format: createMockCurrencyFormat(),
      });

      const transactions = [
        createMockTransaction({
          id: "t1",
          date: dateInMonth(0, 5),
          amount: -25000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
        createMockTransaction({
          id: "t-internal",
          date: dateInMonth(0, 5),
          amount: -100000,
          category_id: "cat-internal",
          payee_id: "payee-1",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({ months: 2, group_by: "category" }),
      );

      // Only the non-internal transaction should be counted
      expect(result.series).toHaveLength(1);
      expect(result.series[0].name).toBe("Groceries");
      expect(result.series[0].total).toBe(25);
    });

    it("filters by category_ids when provided", async () => {
      setupLookups();

      const transactions = [
        createMockTransaction({
          id: "t1",
          date: dateInMonth(0, 5),
          amount: -45000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
        createMockTransaction({
          id: "t2",
          date: dateInMonth(0, 10),
          amount: -120000,
          category_id: "cat-rent",
          payee_id: "payee-landlord",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({
          months: 2,
          group_by: "category",
          category_ids: ["cat-groceries"],
        }),
      );

      expect(result.series).toHaveLength(1);
      expect(result.series[0].name).toBe("Groceries");
      expect(result.series[0].total).toBe(45);
    });

    it("handles split transactions by attributing subtransaction amounts to their categories", async () => {
      setupLookups();

      const transactions = [
        {
          ...createMockTransaction({
            id: "t-split",
            date: dateInMonth(0, 5),
            amount: -60000,
            category_id: "split-parent",
            payee_id: "payee-grocery-store",
          }),
          subtransactions: [
            {
              id: "sub-1",
              transaction_id: "t-split",
              amount: asMilliunits(-35000),
              category_id: "cat-groceries",
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
              transaction_id: "t-split",
              amount: asMilliunits(-25000),
              category_id: "cat-dining",
              category_name: "Dining Out",
              deleted: false,
              payee_id: null,
              payee_name: null,
              memo: null,
              transfer_account_id: null,
              transfer_transaction_id: null,
            },
          ],
        },
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({ months: 2, group_by: "category" }),
      );

      expect(result.series).toHaveLength(2);
      const groceries = result.series.find(
        (s: { name: string }) => s.name === "Groceries",
      );
      const dining = result.series.find(
        (s: { name: string }) => s.name === "Dining Out",
      );
      expect(groceries.total).toBe(35);
      expect(dining.total).toBe(25);
    });
  });

  describe("summary", () => {
    it("identifies highest growth and biggest reduction categories", async () => {
      setupLookups();

      const transactions = [
        // Groceries: prior = $50, current = $80 => +60%
        createMockTransaction({
          id: "t1",
          date: dateInMonth(-1, 10),
          amount: -50000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
        createMockTransaction({
          id: "t2",
          date: dateInMonth(0, 10),
          amount: -80000,
          category_id: "cat-groceries",
          payee_id: "payee-grocery-store",
        }),
        // Rent: prior = $120, current = $60 => -50%
        createMockTransaction({
          id: "t3",
          date: dateInMonth(-1, 10),
          amount: -120000,
          category_id: "cat-rent",
          payee_id: "payee-landlord",
        }),
        createMockTransaction({
          id: "t4",
          date: dateInMonth(0, 10),
          amount: -60000,
          category_id: "cat-rent",
          payee_id: "payee-landlord",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({ months: 2, group_by: "category" }),
      );

      expect(result.summary.highest_growth_category).toBe("Groceries");
      expect(result.summary.highest_growth_percent).toBe(60);
      expect(result.summary.biggest_reduction_category).toBe("Rent");
      expect(result.summary.biggest_reduction_percent).toBe(-50);
    });
  });
});
