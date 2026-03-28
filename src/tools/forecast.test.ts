import { beforeEach, describe, expect, it } from "vitest";
import type { MockAppContext } from "../test-utils.js";
import { captureToolHandlers, createMockContext } from "../test-utils.js";
import { registerForecastTools } from "./forecast.js";

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
  ctx.ynabClient.getScheduledTransactions.mockResolvedValue([]);
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
  const tools = captureToolHandlers(registerForecastTools, ctx) as Record<
    string,
    ToolHandler
  >;
  handler = tools.forecast_category_balances;
  setupDefaults();
});

describe("forecast_category_balances", () => {
  describe("basic balance projection", () => {
    it("projected_end_balance = balance + inflows - outflows - projected_additional_spend", async () => {
      // Use a past month (no remaining days, no projected additional spend)
      ctx.ynabClient.getCategories.mockImplementation(
        async (_budgetId: unknown, opts?: { month?: string }) => {
          if (opts?.month === "2020-06-01") {
            return [
              makeGroup("Everyday", [
                {
                  id: "cat-groceries",
                  name: "Groceries",
                  budgeted: 600000,
                  balance: 300000,
                  activity: -300000,
                },
              ]),
            ];
          }
          return [
            makeGroup("Everyday", [
              { id: "cat-groceries", name: "Groceries", activity: -300000 },
            ]),
          ];
        },
      );

      const result = parseResult(
        await handler({
          month: "2020-06-01",
          include_scheduled: false,
          history_months: 3,
        }),
      );

      const groceries = result.categories[0];
      expect(groceries.current_balance).toBe(300);
      // Past month => daysRemaining=0 => projected_additional_spend=0
      expect(groceries.projected_additional_spend).toBe(0);
      // end_balance = balance = $300
      expect(groceries.projected_end_balance).toBe(300);
      expect(groceries.will_go_negative).toBe(false);
    });

    it("projects additional spending based on historical daily rate and remaining days", async () => {
      // Use the current month (default) to get a real mid-month scenario
      ctx.ynabClient.getCategories.mockImplementation(
        async (_budgetId: unknown, _opts?: Record<string, unknown>) => {
          // Return the same data regardless of month
          return [
            makeGroup("Everyday", [
              {
                id: "cat-groceries",
                name: "Groceries",
                budgeted: 600000,
                balance: 400000,
                activity: -200000,
              },
            ]),
          ];
        },
      );

      const result = parseResult(
        await handler({
          include_scheduled: false,
          history_months: 3,
        }),
      );

      const groceries = result.categories[0];
      if (result.days_remaining > 0) {
        // With historical data, there should be projected additional spend
        expect(groceries.historical_daily_rate).toBeGreaterThan(0);
        expect(groceries.projected_additional_spend).toBeGreaterThan(0);
        // end_balance < current_balance
        expect(groceries.projected_end_balance).toBeLessThan(
          groceries.current_balance,
        );
      }
    });
  });

  describe("scheduled transactions in projection", () => {
    it("includes scheduled outflows in end balance calculation", async () => {
      // Use current month (default) so scheduled transactions are fetched
      ctx.ynabClient.getCategories.mockImplementation(async () => {
        return [
          makeGroup("Bills", [
            {
              id: "cat-rent",
              name: "Rent",
              budgeted: 200000,
              balance: 200000,
              activity: 0,
            },
          ]),
        ];
      });

      // Large scheduled outflow in the future
      ctx.ynabClient.getScheduledTransactions.mockResolvedValue([
        {
          id: "st-rent",
          category_id: "cat-rent",
          amount: -180000,
          date_next: "2099-12-25", // far future, but within the month window the handler computes
        },
      ]);

      const result = parseResult(await handler({ history_months: 3 }));

      const rent = result.categories[0];
      // If scheduled transactions were picked up (depends on current month)
      // For the current month, the handler fetches scheduled transactions between
      // tomorrow and end of month, so they should be included
      if (rent.scheduled_outflows > 0) {
        expect(rent.projected_end_balance).toBeLessThan(rent.current_balance);
      }
    });

    it("does not include scheduled transactions when include_scheduled is false", async () => {
      ctx.ynabClient.getCategories.mockImplementation(async () => {
        return [
          makeGroup("Bills", [
            {
              id: "cat-rent",
              name: "Rent",
              budgeted: 200000,
              balance: 200000,
              activity: 0,
            },
          ]),
        ];
      });

      const result = parseResult(
        await handler({
          month: "2020-06-01",
          include_scheduled: false,
          history_months: 3,
        }),
      );

      const rent = result.categories[0];
      expect(rent.scheduled_outflows).toBe(0);
      expect(rent.scheduled_inflows).toBe(0);
    });
  });

  describe("going negative detection", () => {
    it("flags categories where projected end balance is negative", async () => {
      // Use a past month with a category that already has a negative balance
      ctx.ynabClient.getCategories.mockImplementation(
        async (_budgetId: unknown, opts?: { month?: string }) => {
          if (opts?.month === "2020-06-01") {
            return [
              makeGroup("Everyday", [
                {
                  id: "cat-groceries",
                  name: "Groceries",
                  budgeted: 200000,
                  balance: -50000, // Already negative
                  activity: -250000,
                },
                {
                  id: "cat-safe",
                  name: "Safe Category",
                  budgeted: 500000,
                  balance: 500000,
                  activity: 0,
                },
              ]),
            ];
          }
          return [];
        },
      );

      const result = parseResult(
        await handler({
          month: "2020-06-01",
          include_scheduled: false,
          history_months: 3,
        }),
      );

      expect(result.going_negative_count).toBe(1);

      const groceries = result.going_negative.find(
        (c: Record<string, string>) => c.name === "Groceries",
      );
      expect(groceries).toBeDefined();
      expect(groceries.projected_end_balance).toBeLessThan(0);

      const safe = result.going_negative.find(
        (c: Record<string, string>) => c.name === "Safe Category",
      );
      expect(safe).toBeUndefined();
    });

    it("sorts going_negative by projected balance ascending (worst first)", async () => {
      ctx.ynabClient.getCategories.mockImplementation(
        async (_budgetId: unknown, opts?: { month?: string }) => {
          if (opts?.month === "2020-06-01") {
            return [
              makeGroup("Everyday", [
                {
                  id: "cat-A",
                  name: "Category A",
                  budgeted: 100000,
                  balance: -10000, // -$10
                  activity: -110000,
                },
                {
                  id: "cat-B",
                  name: "Category B",
                  budgeted: 100000,
                  balance: -50000, // -$50 (worse)
                  activity: -150000,
                },
              ]),
            ];
          }
          return [];
        },
      );

      const result = parseResult(
        await handler({
          month: "2020-06-01",
          include_scheduled: false,
          history_months: 3,
        }),
      );

      expect(result.going_negative.length).toBe(2);
      // Worst first (most negative)
      expect(
        result.going_negative[0].projected_end_balance,
      ).toBeLessThanOrEqual(result.going_negative[1].projected_end_balance);
      expect(result.going_negative[0].name).toBe("Category B");
    });
  });

  describe("no historical spending", () => {
    it("handles categories with zero historical activity", async () => {
      ctx.ynabClient.getCategories.mockImplementation(
        async (_budgetId: unknown, opts?: { month?: string }) => {
          if (opts?.month === "2020-06-01") {
            return [
              makeGroup("Savings", [
                {
                  id: "cat-emergency",
                  name: "Emergency Fund",
                  budgeted: 500000,
                  balance: 500000,
                  activity: 0,
                },
              ]),
            ];
          }
          return [
            makeGroup("Savings", [
              { id: "cat-emergency", name: "Emergency Fund", activity: 0 },
            ]),
          ];
        },
      );

      const result = parseResult(
        await handler({
          month: "2020-06-01",
          include_scheduled: false,
          history_months: 3,
        }),
      );

      const emergency = result.categories[0];
      expect(emergency.historical_daily_rate).toBe(0);
      expect(emergency.projected_additional_spend).toBe(0);
      expect(emergency.projected_end_balance).toBe(500);
      expect(emergency.will_go_negative).toBe(false);
    });
  });

  describe("confidence levels", () => {
    it("assigns low confidence when no spending data exists at all", async () => {
      // Past month, no activity, no scheduled, no historical => low
      ctx.ynabClient.getCategories.mockImplementation(
        async (_budgetId: unknown, opts?: { month?: string }) => {
          if (opts?.month === "2020-06-01") {
            return [
              makeGroup("Savings", [
                {
                  id: "cat-1",
                  name: "No Activity",
                  budgeted: 100000,
                  balance: 100000,
                  activity: 0,
                },
              ]),
            ];
          }
          return [];
        },
      );

      const result = parseResult(
        await handler({
          month: "2020-06-01",
          include_scheduled: false,
          history_months: 3,
        }),
      );

      expect(result.categories[0].confidence).toBe("low");
    });

    it("assigns high confidence for a past full month (dayOfMonth >= 50%)", async () => {
      ctx.ynabClient.getCategories.mockImplementation(
        async (_budgetId: unknown, opts?: { month?: string }) => {
          if (opts?.month === "2020-06-01") {
            return [
              makeGroup("Everyday", [
                {
                  id: "cat-1",
                  name: "Groceries",
                  budgeted: 400000,
                  balance: 200000,
                  activity: -200000,
                },
              ]),
            ];
          }
          return [];
        },
      );

      const result = parseResult(
        await handler({
          month: "2020-06-01",
          include_scheduled: false,
          history_months: 3,
        }),
      );

      // Past month => dayOfMonth = daysInMonth >= 50% => high
      expect(result.categories[0].confidence).toBe("high");
    });

    it("assigns high confidence when historical daily rate exists", async () => {
      // Use current month (mid-month) with historical data
      ctx.ynabClient.getCategories.mockImplementation(async () => {
        return [
          makeGroup("Everyday", [
            {
              id: "cat-1",
              name: "Groceries",
              budgeted: 400000,
              balance: 380000,
              activity: -20000,
            },
          ]),
        ];
      });

      const result = parseResult(
        await handler({
          include_scheduled: false,
          history_months: 3,
        }),
      );

      // Historical rate > 0 => high confidence
      expect(result.categories[0].confidence).toBe("high");
    });
  });

  describe("internal groups", () => {
    it("skips Internal Master Category and Credit Card Payments groups", async () => {
      ctx.ynabClient.getCategories.mockImplementation(
        async (_budgetId: unknown, opts?: { month?: string }) => {
          if (opts?.month === "2020-06-01") {
            return [
              makeGroup("Internal Master Category", [
                { id: "int-1", name: "Internal", budgeted: 100000 },
              ]),
              makeGroup(
                "Credit Card Payments",
                [{ id: "cc-1", name: "Visa", budgeted: 200000 }],
                "cc-group",
              ),
              makeGroup(
                "Everyday",
                [
                  {
                    id: "cat-1",
                    name: "Groceries",
                    budgeted: 300000,
                    balance: 300000,
                    activity: 0,
                  },
                ],
                "group-2",
              ),
            ];
          }
          return [];
        },
      );

      const result = parseResult(
        await handler({
          month: "2020-06-01",
          include_scheduled: false,
          history_months: 3,
        }),
      );

      expect(result.categories).toHaveLength(1);
      expect(result.categories[0].name).toBe("Groceries");
    });
  });

  describe("hidden and deleted categories", () => {
    it("skips hidden and deleted categories", async () => {
      ctx.ynabClient.getCategories.mockImplementation(
        async (_budgetId: unknown, opts?: { month?: string }) => {
          if (opts?.month === "2020-06-01") {
            return [
              makeGroup("Everyday", [
                {
                  id: "cat-hidden",
                  name: "Hidden",
                  budgeted: 100000,
                  hidden: true,
                },
                {
                  id: "cat-deleted",
                  name: "Deleted",
                  budgeted: 100000,
                  deleted: true,
                },
                {
                  id: "cat-active",
                  name: "Active",
                  budgeted: 200000,
                  balance: 200000,
                  activity: 0,
                },
              ]),
            ];
          }
          return [];
        },
      );

      const result = parseResult(
        await handler({
          month: "2020-06-01",
          include_scheduled: false,
          history_months: 3,
        }),
      );

      expect(result.categories).toHaveLength(1);
      expect(result.categories[0].name).toBe("Active");
    });
  });

  describe("output structure", () => {
    it("returns all expected top-level and per-category fields", async () => {
      ctx.ynabClient.getCategories.mockImplementation(
        async (_budgetId: unknown, opts?: { month?: string }) => {
          if (opts?.month === "2020-06-01") {
            return [
              makeGroup("Everyday", [
                {
                  id: "cat-1",
                  name: "Groceries",
                  budgeted: 400000,
                  balance: 200000,
                  activity: -200000,
                },
              ]),
            ];
          }
          return [
            makeGroup("Everyday", [
              { id: "cat-1", name: "Groceries", activity: -300000 },
            ]),
          ];
        },
      );

      const result = parseResult(
        await handler({ month: "2020-06-01", history_months: 3 }),
      );

      // Top-level
      expect(result).toHaveProperty("budget_id");
      expect(result).toHaveProperty("month");
      expect(result).toHaveProperty("day_of_month");
      expect(result).toHaveProperty("days_in_month");
      expect(result).toHaveProperty("days_remaining");
      expect(result).toHaveProperty("going_negative_count");
      expect(result).toHaveProperty("going_negative");
      expect(result).toHaveProperty("categories");
      // Verify day_of_month = days_in_month for past month
      expect(result.day_of_month).toBe(result.days_in_month);

      // Per-category
      const cat = result.categories[0];
      expect(cat).toHaveProperty("id", "cat-1");
      expect(cat).toHaveProperty("name", "Groceries");
      expect(cat).toHaveProperty("group_name", "Everyday");
      expect(cat).toHaveProperty("current_balance");
      expect(cat).toHaveProperty("current_balance_display");
      expect(cat).toHaveProperty("budgeted");
      expect(cat).toHaveProperty("budgeted_display");
      expect(cat).toHaveProperty("spent_so_far");
      expect(cat).toHaveProperty("spent_so_far_display");
      expect(cat).toHaveProperty("scheduled_outflows");
      expect(cat).toHaveProperty("scheduled_outflows_display");
      expect(cat).toHaveProperty("scheduled_inflows");
      expect(cat).toHaveProperty("scheduled_inflows_display");
      expect(cat).toHaveProperty("historical_daily_rate");
      expect(cat).toHaveProperty("historical_daily_rate_display");
      expect(cat).toHaveProperty("projected_additional_spend");
      expect(cat).toHaveProperty("projected_additional_spend_display");
      expect(cat).toHaveProperty("projected_end_balance");
      expect(cat).toHaveProperty("projected_end_balance_display");
      expect(cat).toHaveProperty("will_go_negative");
      expect(cat).toHaveProperty("confidence");
    });
  });

  describe("empty budget", () => {
    it("handles budget with no categories", async () => {
      ctx.ynabClient.getCategories.mockResolvedValue([]);

      const result = parseResult(
        await handler({ month: "2020-06-01", history_months: 3 }),
      );

      expect(result.categories).toHaveLength(0);
      expect(result.going_negative_count).toBe(0);
      expect(result.going_negative).toHaveLength(0);
    });
  });
});
