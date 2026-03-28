import { beforeEach, describe, expect, it } from "vitest";
import type { MockAppContext } from "../test-utils.js";
import {
  captureToolHandlers,
  createMockContext,
  createMockCurrencyFormat,
  createMockTransaction,
} from "../test-utils.js";
import { asMilliunits } from "../ynab/format.js";
import { registerBreakdownTools } from "./breakdown.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

let ctx: MockAppContext;
let handler: ToolHandler;

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
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
        { name: "Dining Out", group_id: "group-food", group_name: "Food" },
      ],
    ]),
    payeeById: new Map([
      ["payee-1", "Whole Foods"],
      ["payee-2", "Chipotle"],
    ]),
  });
  ctx.ynabClient.getBudgetSettings.mockResolvedValue({
    currency_format: createMockCurrencyFormat(),
  });
}

beforeEach(() => {
  ctx = createMockContext();
  const tools = captureToolHandlers(registerBreakdownTools, ctx);
  handler = tools.get_spending_breakdown;
});

describe("get_spending_breakdown", () => {
  describe("daily granularity", () => {
    it("groups transactions into daily buckets with correct totals", async () => {
      setupLookups();

      const transactions = [
        createMockTransaction({
          id: "t1",
          date: "2024-03-10",
          amount: -25000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
        createMockTransaction({
          id: "t2",
          date: "2024-03-10",
          amount: -15000,
          category_id: "cat-dining",
          payee_id: "payee-2",
        }),
        createMockTransaction({
          id: "t3",
          date: "2024-03-12",
          amount: -40000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({
          since_date: "2024-03-01",
          until_date: "2024-03-31",
          granularity: "daily",
        }),
      );

      expect(result.bucket_count).toBe(2);
      expect(result.transaction_count).toBe(3);
      // Total: 25 + 15 + 40 = $80
      expect(result.total_spending).toBe(80);

      const march10 = result.buckets.find(
        (b: { key: string }) => b.key === "2024-03-10",
      );
      expect(march10.total).toBe(40); // 25 + 15
      expect(march10.transaction_count).toBe(2);
      expect(march10.percentage).toBe(50);

      const march12 = result.buckets.find(
        (b: { key: string }) => b.key === "2024-03-12",
      );
      expect(march12.total).toBe(40);
      expect(march12.transaction_count).toBe(1);
      expect(march12.percentage).toBe(50);
    });
  });

  describe("weekly granularity", () => {
    it("groups transactions into ISO week buckets starting on Monday", async () => {
      setupLookups();

      // 2024-03-11 is a Monday, 2024-03-18 is the next Monday
      const transactions = [
        createMockTransaction({
          id: "t1",
          date: "2024-03-11", // Monday
          amount: -30000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
        createMockTransaction({
          id: "t2",
          date: "2024-03-14", // Thursday, same week
          amount: -20000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
        createMockTransaction({
          id: "t3",
          date: "2024-03-18", // Next Monday
          amount: -50000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({
          since_date: "2024-03-01",
          until_date: "2024-03-31",
          granularity: "weekly",
        }),
      );

      expect(result.bucket_count).toBe(2);

      const week1 = result.buckets.find(
        (b: { key: string }) => b.key === "2024-03-11",
      );
      expect(week1.label).toBe("Week of 2024-03-11");
      expect(week1.total).toBe(50); // 30 + 20
      expect(week1.transaction_count).toBe(2);

      const week2 = result.buckets.find(
        (b: { key: string }) => b.key === "2024-03-18",
      );
      expect(week2.total).toBe(50);
      expect(week2.transaction_count).toBe(1);
    });
  });

  describe("day_of_week granularity", () => {
    it("groups transactions by day name across multiple weeks", async () => {
      setupLookups();

      // 2024-03-11 = Monday, 2024-03-12 = Tuesday, 2024-03-18 = Monday
      const transactions = [
        createMockTransaction({
          id: "t1",
          date: "2024-03-11", // Monday
          amount: -30000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
        createMockTransaction({
          id: "t2",
          date: "2024-03-12", // Tuesday
          amount: -15000,
          category_id: "cat-dining",
          payee_id: "payee-2",
        }),
        createMockTransaction({
          id: "t3",
          date: "2024-03-18", // Monday
          amount: -45000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({
          since_date: "2024-03-01",
          until_date: "2024-03-31",
          granularity: "day_of_week",
        }),
      );

      expect(result.bucket_count).toBe(2);
      // Total: 30 + 15 + 45 = $90

      const monday = result.buckets.find(
        (b: { label: string }) => b.label === "Monday",
      );
      expect(monday.total).toBe(75); // 30 + 45
      expect(monday.transaction_count).toBe(2);
      // Monday percentage: 75/90 = 83.33%
      expect(monday.percentage).toBeCloseTo(83.33, 1);

      const tuesday = result.buckets.find(
        (b: { label: string }) => b.label === "Tuesday",
      );
      expect(tuesday.total).toBe(15);
      expect(tuesday.transaction_count).toBe(1);
      // Tuesday percentage: 15/90 = 16.67%
      expect(tuesday.percentage).toBeCloseTo(16.67, 1);
    });
  });

  describe("week_of_month granularity", () => {
    it("groups transactions by week number within the month", async () => {
      setupLookups();

      const transactions = [
        createMockTransaction({
          id: "t1",
          date: "2024-03-03", // Day 3 => Week 1
          amount: -20000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
        createMockTransaction({
          id: "t2",
          date: "2024-03-05", // Day 5 => Week 1
          amount: -10000,
          category_id: "cat-dining",
          payee_id: "payee-2",
        }),
        createMockTransaction({
          id: "t3",
          date: "2024-03-10", // Day 10 => Week 2
          amount: -35000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
        createMockTransaction({
          id: "t4",
          date: "2024-03-22", // Day 22 => Week 4
          amount: -55000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({
          since_date: "2024-03-01",
          until_date: "2024-03-31",
          granularity: "week_of_month",
        }),
      );

      expect(result.bucket_count).toBe(3);

      const week1 = result.buckets.find(
        (b: { label: string }) => b.label === "Week 1",
      );
      expect(week1.total).toBe(30); // 20 + 10
      expect(week1.transaction_count).toBe(2);

      const week2 = result.buckets.find(
        (b: { label: string }) => b.label === "Week 2",
      );
      expect(week2.total).toBe(35);
      expect(week2.transaction_count).toBe(1);

      const week4 = result.buckets.find(
        (b: { label: string }) => b.label === "Week 4",
      );
      expect(week4.total).toBe(55);
      expect(week4.transaction_count).toBe(1);
    });
  });

  describe("percentages", () => {
    it("computes bucket percentages that sum to 100%", async () => {
      setupLookups();

      const transactions = [
        createMockTransaction({
          id: "t1",
          date: "2024-03-05",
          amount: -25000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
        createMockTransaction({
          id: "t2",
          date: "2024-03-15",
          amount: -50000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
        createMockTransaction({
          id: "t3",
          date: "2024-03-25",
          amount: -25000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({
          since_date: "2024-03-01",
          until_date: "2024-03-31",
          granularity: "daily",
        }),
      );

      const totalPercentage = result.buckets.reduce(
        (sum: number, b: { percentage: number }) => sum + b.percentage,
        0,
      );
      expect(totalPercentage).toBeCloseTo(100, 0);

      // 25/100 = 25%, 50/100 = 50%, 25/100 = 25%
      const march5 = result.buckets.find(
        (b: { key: string }) => b.key === "2024-03-05",
      );
      expect(march5.percentage).toBe(25);
      const march15 = result.buckets.find(
        (b: { key: string }) => b.key === "2024-03-15",
      );
      expect(march15.percentage).toBe(50);
    });
  });

  describe("insights: highest and lowest buckets", () => {
    it("identifies highest and lowest spending buckets", async () => {
      setupLookups();

      const transactions = [
        createMockTransaction({
          id: "t1",
          date: "2024-03-05",
          amount: -10000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
        createMockTransaction({
          id: "t2",
          date: "2024-03-15",
          amount: -80000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
        createMockTransaction({
          id: "t3",
          date: "2024-03-25",
          amount: -30000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({
          since_date: "2024-03-01",
          until_date: "2024-03-31",
          granularity: "daily",
        }),
      );

      expect(result.insights.highest_bucket.label).toBe("2024-03-15");
      expect(result.insights.highest_bucket.total_display).toBe("$80.00");
      // 80 / 120 = 66.67%
      expect(result.insights.highest_bucket.percentage).toBeCloseTo(66.67, 1);

      expect(result.insights.lowest_bucket.label).toBe("2024-03-05");
      expect(result.insights.lowest_bucket.total_display).toBe("$10.00");
      // 10 / 120 = 8.33%
      expect(result.insights.lowest_bucket.percentage).toBeCloseTo(8.33, 1);
    });

    it("computes average per bucket and standard deviation", async () => {
      setupLookups();

      // Three daily buckets: $10, $20, $30 => avg = $20, stddev ~= $8.16
      const transactions = [
        createMockTransaction({
          id: "t1",
          date: "2024-03-05",
          amount: -10000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
        createMockTransaction({
          id: "t2",
          date: "2024-03-10",
          amount: -20000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
        createMockTransaction({
          id: "t3",
          date: "2024-03-15",
          amount: -30000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({
          since_date: "2024-03-01",
          until_date: "2024-03-31",
          granularity: "daily",
        }),
      );

      // Average per bucket: (10k + 20k + 30k) / 3 = 20000 milliunits = $20
      expect(result.insights.average_per_bucket).toBe(20);

      // Std dev: sqrt(((10k-20k)^2 + (20k-20k)^2 + (30k-20k)^2) / 3) = sqrt(200000000/3) ~= 8165
      // Rounded by code: 8165 milliunits = $8.165 => $8.17 (or similar depending on rounding)
      expect(result.insights.std_deviation).toBeCloseTo(8.165, 0);
    });
  });

  describe("edge cases", () => {
    it("handles empty date range (no transactions)", async () => {
      setupLookups();
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue([]);

      const result = parseResult(
        await handler({
          since_date: "2024-03-01",
          until_date: "2024-03-31",
          granularity: "daily",
        }),
      );

      expect(result.buckets).toHaveLength(0);
      expect(result.bucket_count).toBe(0);
      expect(result.transaction_count).toBe(0);
      expect(result.total_spending).toBe(0);
      expect(result.insights.highest_bucket).toBeNull();
      expect(result.insights.lowest_bucket).toBeNull();
      expect(result.insights.average_per_bucket).toBe(0);
      expect(result.insights.std_deviation).toBe(0);
    });

    it("excludes transfers (transactions with transfer_account_id)", async () => {
      setupLookups();

      const transactions = [
        createMockTransaction({
          id: "t-transfer",
          date: "2024-03-10",
          amount: -200000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
          transfer_account_id: "acc-savings",
        }),
        createMockTransaction({
          id: "t-real",
          date: "2024-03-10",
          amount: -30000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({
          since_date: "2024-03-01",
          until_date: "2024-03-31",
          granularity: "daily",
        }),
      );

      expect(result.total_spending).toBe(30);
      expect(result.transaction_count).toBe(1);
    });

    it("excludes income (positive amounts)", async () => {
      setupLookups();

      const transactions = [
        createMockTransaction({
          id: "t-income",
          date: "2024-03-10",
          amount: 500000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
        createMockTransaction({
          id: "t-expense",
          date: "2024-03-10",
          amount: -22000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({
          since_date: "2024-03-01",
          until_date: "2024-03-31",
          granularity: "daily",
        }),
      );

      expect(result.total_spending).toBe(22);
      expect(result.transaction_count).toBe(1);
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
          id: "t-grocery",
          date: "2024-03-10",
          amount: -30000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
        createMockTransaction({
          id: "t-internal",
          date: "2024-03-10",
          amount: -100000,
          category_id: "cat-internal",
          payee_id: "payee-1",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({
          since_date: "2024-03-01",
          until_date: "2024-03-31",
          granularity: "daily",
        }),
      );

      expect(result.total_spending).toBe(30);
      expect(result.transaction_count).toBe(1);
    });

    it("filters by category_ids when provided", async () => {
      setupLookups();

      const transactions = [
        createMockTransaction({
          id: "t1",
          date: "2024-03-10",
          amount: -30000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
        createMockTransaction({
          id: "t2",
          date: "2024-03-10",
          amount: -25000,
          category_id: "cat-dining",
          payee_id: "payee-2",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({
          since_date: "2024-03-01",
          until_date: "2024-03-31",
          granularity: "daily",
          category_ids: ["cat-groceries"],
        }),
      );

      expect(result.total_spending).toBe(30);
      expect(result.transaction_count).toBe(1);
    });

    it("handles split transactions by counting each subtransaction", async () => {
      setupLookups();

      const transactions = [
        {
          ...createMockTransaction({
            id: "t-split",
            date: "2024-03-10",
            amount: -55000,
            category_id: "split-parent",
            payee_id: "payee-1",
          }),
          subtransactions: [
            {
              id: "sub-1",
              transaction_id: "t-split",
              amount: asMilliunits(-30000),
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
        await handler({
          since_date: "2024-03-01",
          until_date: "2024-03-31",
          granularity: "daily",
        }),
      );

      // Both subtransactions on 2024-03-10
      expect(result.total_spending).toBe(55);
      expect(result.transaction_count).toBe(2);
      expect(result.bucket_count).toBe(1);
      expect(result.buckets[0].total).toBe(55);
    });

    it("buckets are sorted by key", async () => {
      setupLookups();

      // Insert in reverse chronological order to ensure sorting works
      const transactions = [
        createMockTransaction({
          id: "t3",
          date: "2024-03-25",
          amount: -10000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
        createMockTransaction({
          id: "t1",
          date: "2024-03-05",
          amount: -20000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
        createMockTransaction({
          id: "t2",
          date: "2024-03-15",
          amount: -30000,
          category_id: "cat-groceries",
          payee_id: "payee-1",
        }),
      ];
      ctx.ynabClient.getTransactionsInRange.mockResolvedValue(transactions);

      const result = parseResult(
        await handler({
          since_date: "2024-03-01",
          until_date: "2024-03-31",
          granularity: "daily",
        }),
      );

      const keys = result.buckets.map((b: { key: string }) => b.key);
      expect(keys).toEqual(["2024-03-05", "2024-03-15", "2024-03-25"]);
    });
  });
});
