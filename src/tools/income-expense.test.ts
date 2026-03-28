import { beforeEach, describe, expect, it } from "vitest";
import type { MockAppContext } from "../test-utils.js";
import {
  captureToolHandlers,
  createMockContext,
  createMockCurrencyFormat,
} from "../test-utils.js";
import { registerIncomeExpenseTools } from "./income-expense.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

let ctx: MockAppContext;
let handler: ToolHandler;

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/** Build a YYYY-MM key relative to the current month. */
function monthKey(offset: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Set up getMonthSummary to return provided monthly data.
 * Each entry maps a month offset (0=current, -1=last month, etc.) to { income, activity }.
 * income is in milliunits (positive), activity is in milliunits (negative for spending).
 */
function setupMonthSummaries(
  data: Array<{ offset: number; income: number; activity: number }>,
) {
  ctx.ynabClient.getBudgetSettings.mockResolvedValue({
    currency_format: createMockCurrencyFormat(),
  });

  // Build a map of month-key-with-01 -> summary
  const summaryMap = new Map<string, { income: number; activity: number }>();
  for (const entry of data) {
    const key = `${monthKey(entry.offset)}-01`;
    summaryMap.set(key, { income: entry.income, activity: entry.activity });
  }

  ctx.ynabClient.getMonthSummary.mockImplementation(
    async (_budgetId: string | undefined, monthDate: string) => {
      const summary = summaryMap.get(monthDate);
      if (summary) {
        return summary;
      }
      return { income: 0, activity: 0 };
    },
  );
}

beforeEach(() => {
  ctx = createMockContext();
  const tools = captureToolHandlers(registerIncomeExpenseTools, ctx);
  handler = tools.get_income_expense_summary;
});

describe("get_income_expense_summary", () => {
  describe("per-month computations", () => {
    it("computes income, expenses, net, and savings rate correctly per month", async () => {
      setupMonthSummaries([
        // Last month: income $5000, spent $3000
        { offset: -1, income: 5000000, activity: -3000000 },
        // Current month: income $5000, spent $4000
        { offset: 0, income: 5000000, activity: -4000000 },
      ]);

      const result = parseResult(await handler({ months: 2 }));

      expect(result.months).toHaveLength(2);

      const lastMonth = result.months.find(
        (m: { month: string }) => m.month === monthKey(-1),
      );
      expect(lastMonth.income).toBe(5000);
      expect(lastMonth.expenses).toBe(3000);
      expect(lastMonth.net).toBe(2000);
      // savings rate = (5000 - 3000) / 5000 = 40%
      expect(lastMonth.savings_rate).toBe(40);

      const currentMonth = result.months.find(
        (m: { month: string }) => m.month === monthKey(0),
      );
      expect(currentMonth.income).toBe(5000);
      expect(currentMonth.expenses).toBe(4000);
      expect(currentMonth.net).toBe(1000);
      // savings rate = (5000 - 4000) / 5000 = 20%
      expect(currentMonth.savings_rate).toBe(20);
    });

    it("handles negative net (expenses exceed income)", async () => {
      setupMonthSummaries([
        { offset: -1, income: 3000000, activity: -4500000 },
        { offset: 0, income: 3000000, activity: -3500000 },
      ]);

      const result = parseResult(await handler({ months: 2 }));

      const lastMonth = result.months.find(
        (m: { month: string }) => m.month === monthKey(-1),
      );
      expect(lastMonth.net).toBe(-1500);
      // savings rate = (3000 - 4500) / 3000 = -50%
      expect(lastMonth.savings_rate).toBe(-50);
    });
  });

  describe("averages", () => {
    it("computes averages across all months correctly", async () => {
      setupMonthSummaries([
        { offset: -2, income: 4000000, activity: -2000000 },
        { offset: -1, income: 5000000, activity: -3000000 },
        { offset: 0, income: 6000000, activity: -4000000 },
      ]);

      const result = parseResult(await handler({ months: 3 }));

      // Avg income: (4000 + 5000 + 6000) / 3 = 5000
      expect(result.averages.avg_income).toBe(5000);
      // Avg expenses: (2000 + 3000 + 4000) / 3 = 3000
      expect(result.averages.avg_expenses).toBe(3000);
      // Avg net: (15000000 - 9000000) / 3 = 2000000 milliunits = $2000
      expect(result.averages.avg_net).toBe(2000);
      // Avg savings rate: (15000000 - 9000000) / 15000000 = 40%
      expect(result.averages.avg_savings_rate).toBe(40);
    });
  });

  describe("trend direction", () => {
    it("detects improving trend when recent savings rate exceeds prior by >2%", async () => {
      // 4 months: prior (months -3, -2) and recent (months -1, 0)
      // Prior: income $5000, expenses $4500 each => savings rate = 10%
      // Recent: income $5000, expenses $2500 each => savings rate = 50%
      setupMonthSummaries([
        { offset: -3, income: 5000000, activity: -4500000 },
        { offset: -2, income: 5000000, activity: -4500000 },
        { offset: -1, income: 5000000, activity: -2500000 },
        { offset: 0, income: 5000000, activity: -2500000 },
      ]);

      const result = parseResult(await handler({ months: 4 }));

      expect(result.trend.direction).toBe("improving");
      expect(result.trend.recent_savings_rate).toBe(50);
      expect(result.trend.prior_savings_rate).toBe(10);
    });

    it("detects declining trend when recent savings rate falls below prior by >2%", async () => {
      // Prior: income $5000, expenses $2000 each => savings rate = 60%
      // Recent: income $5000, expenses $4800 each => savings rate = 4%
      setupMonthSummaries([
        { offset: -3, income: 5000000, activity: -2000000 },
        { offset: -2, income: 5000000, activity: -2000000 },
        { offset: -1, income: 5000000, activity: -4800000 },
        { offset: 0, income: 5000000, activity: -4800000 },
      ]);

      const result = parseResult(await handler({ months: 4 }));

      expect(result.trend.direction).toBe("declining");
      expect(result.trend.recent_savings_rate).toBe(4);
      expect(result.trend.prior_savings_rate).toBe(60);
    });

    it("detects stable trend when savings rate difference is within 2%", async () => {
      // All months virtually the same
      setupMonthSummaries([
        { offset: -3, income: 5000000, activity: -3000000 },
        { offset: -2, income: 5000000, activity: -3000000 },
        { offset: -1, income: 5000000, activity: -3050000 },
        { offset: 0, income: 5000000, activity: -2950000 },
      ]);

      const result = parseResult(await handler({ months: 4 }));

      expect(result.trend.direction).toBe("stable");
    });
  });

  describe("edge cases", () => {
    it("handles months with zero income", async () => {
      setupMonthSummaries([
        { offset: -1, income: 0, activity: -1500000 },
        { offset: 0, income: 5000000, activity: -3000000 },
      ]);

      const result = parseResult(await handler({ months: 2 }));

      const zeroIncomeMonth = result.months.find(
        (m: { month: string }) => m.month === monthKey(-1),
      );
      expect(zeroIncomeMonth.income).toBe(0);
      expect(zeroIncomeMonth.expenses).toBe(1500);
      expect(zeroIncomeMonth.net).toBe(-1500);
      // savings rate should be 0 when income is 0
      expect(zeroIncomeMonth.savings_rate).toBe(0);
    });

    it("handles all months with zero income", async () => {
      setupMonthSummaries([
        { offset: -1, income: 0, activity: -500000 },
        { offset: 0, income: 0, activity: -300000 },
      ]);

      const result = parseResult(await handler({ months: 2 }));

      expect(result.averages.avg_savings_rate).toBe(0);
      expect(result.trend.recent_savings_rate).toBe(0);
      expect(result.trend.prior_savings_rate).toBe(0);
      expect(result.trend.direction).toBe("stable");
    });

    it("handles months with zero activity", async () => {
      setupMonthSummaries([
        { offset: -1, income: 5000000, activity: 0 },
        { offset: 0, income: 5000000, activity: 0 },
      ]);

      const result = parseResult(await handler({ months: 2 }));

      for (const m of result.months) {
        expect(m.expenses).toBe(0);
        expect(m.net).toBe(5000);
        expect(m.savings_rate).toBe(100);
      }
      expect(result.averages.avg_savings_rate).toBe(100);
    });

    it("returns correct number of months based on input", async () => {
      setupMonthSummaries([
        { offset: -5, income: 5000000, activity: -3000000 },
        { offset: -4, income: 5000000, activity: -3000000 },
        { offset: -3, income: 5000000, activity: -3000000 },
        { offset: -2, income: 5000000, activity: -3000000 },
        { offset: -1, income: 5000000, activity: -3000000 },
        { offset: 0, income: 5000000, activity: -3000000 },
      ]);

      const result = parseResult(await handler({ months: 6 }));

      expect(result.months).toHaveLength(6);
      // Verify the month keys are chronologically ordered
      for (let i = 0; i < result.months.length - 1; i++) {
        expect(result.months[i].month < result.months[i + 1].month).toBe(true);
      }
    });

    it("uses default months=6 when not specified", async () => {
      // Set up enough months for the default
      const entries = [];
      for (let i = -5; i <= 0; i++) {
        entries.push({ offset: i, income: 5000000, activity: -3000000 });
      }
      setupMonthSummaries(entries);

      const result = parseResult(await handler({}));

      expect(result.months).toHaveLength(6);
    });
  });
});
