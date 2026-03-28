import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockAppContext } from "../test-utils.js";
import { captureToolHandlers, createMockContext } from "../test-utils.js";
import { registerVelocityTools } from "./velocity.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

let ctx: MockAppContext;
let handler: ToolHandler;

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function makeGroup(
  name: string,
  categories: Array<Record<string, unknown>>,
  id = "group-1",
) {
  return {
    id,
    name,
    hidden: false,
    deleted: false,
    categories: categories.map((c) => ({
      hidden: false,
      deleted: false,
      balance: 0,
      budgeted: 0,
      activity: 0,
      goal_type: null,
      goal_under_funded: null,
      ...c,
    })),
  };
}

function setupDefaults() {
  ctx.ynabClient.getCategories.mockResolvedValue([]);
  ctx.ynabClient.getBudgetSettings.mockResolvedValue({
    currency_format: {
      currency_symbol: "$",
      decimal_digits: 2,
      decimal_separator: ".",
      group_separator: ",",
      symbol_first: true,
      display_symbol: true,
    },
  });
}

beforeEach(() => {
  ctx = createMockContext();
  const tools = captureToolHandlers(registerVelocityTools, ctx) as Record<
    string,
    ToolHandler
  >;
  handler = tools.get_spending_velocity;
  setupDefaults();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("get_spending_velocity", () => {
  describe("date calculations", () => {
    it("for a past month, day_of_month equals days_in_month with zero remaining", async () => {
      // Use a month string that is definitely in the past relative to any timezone
      const result = parseResult(await handler({ month: "2020-01-01" }));

      expect(result.day_of_month).toBe(result.days_in_month);
      expect(result.days_remaining).toBe(0);
    });

    it("for a future month, day_of_month is 0 and days_remaining equals days_in_month", async () => {
      const result = parseResult(await handler({ month: "2099-01-01" }));

      expect(result.day_of_month).toBe(0);
      expect(result.days_remaining).toBe(result.days_in_month);
    });

    it("day_of_month + days_remaining equals days_in_month", async () => {
      // Use default month (current month)
      const result = parseResult(await handler({}));

      expect(result.day_of_month + result.days_remaining).toBe(
        result.days_in_month,
      );
    });
  });

  describe("burn rate and projection", () => {
    it("computes burn rate proportional to spending and inversely proportional to days", async () => {
      // Use a past month so dayOfMonth = daysInMonth (full month)
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Everyday", [
          {
            id: "cat-groceries",
            name: "Groceries",
            budgeted: 600000,
            activity: -310000, // $310 spent
            balance: 290000,
          },
        ]),
      ]);

      const result = parseResult(
        await handler({ month: "2020-06-01", history_months: 1 }),
      );

      const groceries = result.categories[0];
      const dayOfMonth = result.day_of_month;
      const daysInMonth = result.days_in_month;

      // Past month => dayOfMonth = daysInMonth
      expect(dayOfMonth).toBe(daysInMonth);

      // For a full past month: burn_rate * daysInMonth = spent, so projected = spent
      // projected_total_spend should approximately equal spent_so_far
      expect(groceries.projected_total_spend).toBeCloseTo(
        groceries.spent_so_far,
        0,
      );
      // projected_remaining = budgeted - projected_total_spend = budgeted - spent
      expect(groceries.projected_remaining).toBeCloseTo(
        groceries.budgeted - groceries.spent_so_far,
        0,
      );
    });

    it("projected_total_spend = daily_burn_rate * days_in_month", async () => {
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Everyday", [
          {
            id: "cat-dining",
            name: "Dining Out",
            budgeted: 200000,
            activity: -100000,
            balance: 100000,
          },
        ]),
      ]);

      // Use default (current month) so we get a real mid-month scenario
      const result = parseResult(await handler({ history_months: 1 }));

      if (result.day_of_month > 0) {
        const dining = result.categories[0];
        const expectedProjected = dining.daily_burn_rate * result.days_in_month;
        // Allow for rounding differences
        expect(dining.projected_total_spend).toBeCloseTo(expectedProjected, 0);
      }
    });
  });

  describe("risk classification", () => {
    it("classifies likely_overspend when spending pace far exceeds budget", async () => {
      // Use a past month: all spending happened, projected = spent = $400 on $200 budget
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Everyday", [
          {
            id: "cat-1",
            name: "Groceries",
            budgeted: 200000,
            activity: -400000, // Spent double the budget
            balance: -200000,
          },
        ]),
      ]);

      const result = parseResult(
        await handler({ month: "2020-06-01", history_months: 1 }),
      );

      // projected = spent ($400) > 110% of budgeted ($200) => likely_overspend
      expect(result.categories[0].risk).toBe("likely_overspend");
      expect(result.at_risk_count).toBe(1);
      expect(result.overall_status).toBe("at_risk");
    });

    it("classifies watch when spending is between 90% and 110% of budget", async () => {
      // Past month: spent $285 on $300 budget = 95% = between 90-110%
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Everyday", [
          {
            id: "cat-1",
            name: "Groceries",
            budgeted: 300000,
            activity: -285000,
            balance: 15000,
          },
        ]),
      ]);

      const result = parseResult(
        await handler({ month: "2020-06-01", history_months: 1 }),
      );

      expect(result.categories[0].risk).toBe("watch");
      expect(result.overall_status).toBe("watch");
    });

    it("classifies safe when spending is well under budget", async () => {
      // Past month: spent $100 on $500 budget = 20%
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Everyday", [
          {
            id: "cat-1",
            name: "Groceries",
            budgeted: 500000,
            activity: -100000,
            balance: 400000,
          },
        ]),
      ]);

      const result = parseResult(
        await handler({ month: "2020-06-01", history_months: 1 }),
      );

      expect(result.categories[0].risk).toBe("safe");
      expect(result.overall_status).toBe("on_track");
      expect(result.at_risk_count).toBe(0);
    });
  });

  describe("zero spending categories", () => {
    it("handles category with zero activity", async () => {
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Bills", [
          {
            id: "cat-insurance",
            name: "Insurance",
            budgeted: 150000,
            activity: 0,
            balance: 150000,
          },
        ]),
      ]);

      const result = parseResult(
        await handler({ month: "2020-06-01", history_months: 1 }),
      );

      const insurance = result.categories[0];
      expect(insurance.daily_burn_rate).toBe(0);
      expect(insurance.projected_total_spend).toBe(0);
      expect(insurance.projected_remaining).toBe(150);
      expect(insurance.risk).toBe("safe");
    });
  });

  describe("future month", () => {
    it("returns zero burn rate when day_of_month is 0", async () => {
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Everyday", [
          {
            id: "cat-1",
            name: "Groceries",
            budgeted: 400000,
            activity: 0,
            balance: 400000,
          },
        ]),
      ]);

      const result = parseResult(
        await handler({ month: "2099-06-01", history_months: 1 }),
      );

      expect(result.day_of_month).toBe(0);
      expect(result.categories[0].daily_burn_rate).toBe(0);
      expect(result.categories[0].projected_total_spend).toBe(0);
    });
  });

  describe("categories with zero budget", () => {
    it("skips categories with zero or negative budgeted amount", async () => {
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Everyday", [
          {
            id: "cat-1",
            name: "Zero Budget",
            budgeted: 0,
            activity: -5000,
            balance: -5000,
          },
          {
            id: "cat-2",
            name: "Has Budget",
            budgeted: 100000,
            activity: -20000,
            balance: 80000,
          },
        ]),
      ]);

      const result = parseResult(
        await handler({ month: "2020-06-01", history_months: 1 }),
      );

      expect(result.categories).toHaveLength(1);
      expect(result.categories[0].name).toBe("Has Budget");
    });
  });

  describe("internal groups are skipped", () => {
    it("excludes Internal Master Category and Credit Card Payments", async () => {
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Internal Master Category", [
          { id: "int-1", name: "Internal", budgeted: 100000, activity: -50000 },
        ]),
        makeGroup(
          "Credit Card Payments",
          [{ id: "cc-1", name: "Visa", budgeted: 200000, activity: -100000 }],
          "cc-group",
        ),
        makeGroup(
          "Everyday",
          [
            {
              id: "cat-1",
              name: "Groceries",
              budgeted: 300000,
              activity: -100000,
              balance: 200000,
            },
          ],
          "group-2",
        ),
      ]);

      const result = parseResult(
        await handler({ month: "2020-06-01", history_months: 1 }),
      );

      expect(result.categories).toHaveLength(1);
      expect(result.categories[0].name).toBe("Groceries");
    });
  });

  describe("historical comparison", () => {
    it("fetches historical data and populates historical_monthly_avg", async () => {
      ctx.ynabClient.getCategories.mockImplementation(
        async (_budgetId: unknown, opts?: { month?: string }) => {
          if (opts?.month === "2020-06-01") {
            return [
              makeGroup("Everyday", [
                {
                  id: "cat-1",
                  name: "Groceries",
                  budgeted: 400000,
                  activity: -100000,
                  balance: 300000,
                },
              ]),
            ];
          }
          // Historical months all had $300 spending
          return [
            makeGroup("Everyday", [
              {
                id: "cat-1",
                name: "Groceries",
                activity: -300000,
                balance: 100000,
              },
            ]),
          ];
        },
      );

      const result = parseResult(
        await handler({ month: "2020-06-01", history_months: 3 }),
      );

      // Each of 3 months has 300000 activity => avg = 300000 = $300
      expect(result.categories[0].historical_monthly_avg).toBe(300);
    });

    it("returns null historical_monthly_avg when no history exists", async () => {
      ctx.ynabClient.getCategories.mockImplementation(
        async (_budgetId: unknown, opts?: { month?: string }) => {
          if (opts?.month === "2020-06-01") {
            return [
              makeGroup("Everyday", [
                {
                  id: "cat-1",
                  name: "Groceries",
                  budgeted: 400000,
                  activity: -100000,
                  balance: 300000,
                },
              ]),
            ];
          }
          return [
            makeGroup("Everyday", [
              { id: "cat-1", name: "Groceries", activity: 0, balance: 400000 },
            ]),
          ];
        },
      );

      const result = parseResult(
        await handler({ month: "2020-06-01", history_months: 3 }),
      );

      expect(result.categories[0].historical_monthly_avg).toBeNull();
    });
  });

  describe("at_risk summary", () => {
    it("at-risk categories are sorted by projected overspend descending", async () => {
      // Past month: Groceries overspent heavily, Dining moderately, Fun Money safe
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Everyday", [
          {
            id: "cat-1",
            name: "Groceries",
            budgeted: 200000,
            activity: -400000, // 200% of budget
            balance: -200000,
          },
          {
            id: "cat-2",
            name: "Dining",
            budgeted: 100000,
            activity: -120000, // 120% of budget
            balance: -20000,
          },
          {
            id: "cat-3",
            name: "Fun Money",
            budgeted: 500000,
            activity: -10000, // 2% of budget
            balance: 490000,
          },
        ]),
      ]);

      const result = parseResult(
        await handler({ month: "2020-06-01", history_months: 1 }),
      );

      // Both Groceries and Dining should be at risk
      expect(result.at_risk.length).toBeGreaterThanOrEqual(2);
      // Sorted by projected overspend descending: Groceries first
      expect(result.at_risk[0].name).toBe("Groceries");
      expect(result.at_risk[0].projected_overspend).toBeGreaterThan(
        result.at_risk[1].projected_overspend,
      );
    });
  });

  describe("output structure", () => {
    it("returns all expected top-level fields", async () => {
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Everyday", [
          {
            id: "cat-1",
            name: "Groceries",
            budgeted: 300000,
            activity: -100000,
            balance: 200000,
          },
        ]),
      ]);

      const result = parseResult(
        await handler({ month: "2020-06-01", history_months: 1 }),
      );

      expect(result).toHaveProperty("budget_id");
      expect(result).toHaveProperty("month");
      expect(result).toHaveProperty("day_of_month");
      expect(result).toHaveProperty("days_in_month");
      expect(result).toHaveProperty("days_remaining");
      expect(result).toHaveProperty("overall_status");
      expect(result).toHaveProperty("at_risk_count");
      expect(result).toHaveProperty("at_risk");
      expect(result).toHaveProperty("categories");

      const cat = result.categories[0];
      expect(cat).toHaveProperty("id", "cat-1");
      expect(cat).toHaveProperty("name", "Groceries");
      expect(cat).toHaveProperty("group_name", "Everyday");
      expect(cat).toHaveProperty("budgeted");
      expect(cat).toHaveProperty("budgeted_display");
      expect(cat).toHaveProperty("spent_so_far");
      expect(cat).toHaveProperty("daily_burn_rate");
      expect(cat).toHaveProperty("projected_total_spend");
      expect(cat).toHaveProperty("projected_remaining");
      expect(cat).toHaveProperty("risk");
      expect(cat).toHaveProperty("historical_monthly_avg");
    });
  });
});
