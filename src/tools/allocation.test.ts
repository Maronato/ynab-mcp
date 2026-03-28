import { beforeEach, describe, expect, it } from "vitest";
import type { MockAppContext } from "../test-utils.js";
import { captureToolHandlers, createMockContext } from "../test-utils.js";
import { registerAllocationTools } from "./allocation.js";

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
      goal_target: null,
      goal_under_funded: null,
      goal_target_date: null,
      ...c,
    })),
  };
}

function setupDefaults() {
  ctx.ynabClient.getMonthSummary.mockResolvedValue({
    to_be_budgeted: 500000, // $500 RTA
    categories: [],
  });
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
  const tools = captureToolHandlers(registerAllocationTools, ctx) as Record<
    string,
    ToolHandler
  >;
  handler = tools.suggest_budget_allocation;
  setupDefaults();
});

describe("suggest_budget_allocation", () => {
  describe("priority ordering", () => {
    it("allocates P1 bills before P2 monthly, P3 variable, P4 savings", async () => {
      ctx.ynabClient.getMonthSummary.mockResolvedValue({
        to_be_budgeted: 1000000, // $1000 available
      });

      ctx.ynabClient.getCategories.mockImplementation(
        async (_budgetId: unknown, opts?: { month?: string }) => {
          if (opts?.month && opts.month < "2024-06-01") {
            // Historical data for P3 variable spending
            return [
              makeGroup(
                "Everyday",
                [
                  {
                    id: "cat-fun",
                    name: "Fun Money",
                    activity: -150000,
                    balance: 0,
                  },
                ],
                "group-3",
              ),
            ];
          }
          return [
            // P1: NEED target, underfunded
            makeGroup("Bills", [
              {
                id: "cat-rent",
                name: "Rent",
                budgeted: 0,
                goal_type: "NEED",
                goal_under_funded: 200000, // needs $200
                goal_target_date: "2024-06-15",
              },
            ]),
            // P2: MF target, underfunded
            makeGroup(
              "Monthly",
              [
                {
                  id: "cat-groceries",
                  name: "Groceries",
                  budgeted: 100000,
                  goal_type: "MF",
                  goal_under_funded: 150000, // needs $150 more
                },
              ],
              "group-2",
            ),
            // P3: Variable spending (via historical avg exceeding balance)
            makeGroup(
              "Everyday",
              [
                {
                  id: "cat-fun",
                  name: "Fun Money",
                  budgeted: 0,
                  balance: 0,
                  activity: 0,
                  // No target -- will be P3 if historical avg > balance
                },
              ],
              "group-3",
            ),
            // P4: TB savings target, underfunded
            makeGroup(
              "Savings",
              [
                {
                  id: "cat-emergency",
                  name: "Emergency Fund",
                  budgeted: 0,
                  goal_type: "TB",
                  goal_under_funded: 300000, // needs $300
                },
              ],
              "group-4",
            ),
          ];
        },
      );

      const result = parseResult(
        await handler({ month: "2024-06-01", history_months: 3 }),
      );

      // Check allocation order by priority
      const priorities = result.allocations.map(
        (a: Record<string, string>) => a.priority,
      );

      const p1Index = priorities.indexOf("P1_bills_due");
      const p2Index = priorities.indexOf("P2_monthly_contribution");
      const p4Index = priorities.indexOf("P4_savings");

      expect(p1Index).toBeGreaterThanOrEqual(0);
      expect(p2Index).toBeGreaterThan(p1Index);
      expect(p4Index).toBeGreaterThan(p2Index);

      // Verify amounts: P1 rent = $200, P2 groceries = $150
      const rent = result.allocations.find(
        (a: Record<string, string>) => a.category_name === "Rent",
      );
      expect(rent.amount).toBe(200);
      expect(rent.priority).toBe("P1_bills_due");

      const groceries = result.allocations.find(
        (a: Record<string, string>) => a.category_name === "Groceries",
      );
      expect(groceries.amount).toBe(150);
      expect(groceries.priority).toBe("P2_monthly_contribution");
    });
  });

  describe("respects available amount limit", () => {
    it("stops allocating when funds run out", async () => {
      ctx.ynabClient.getMonthSummary.mockResolvedValue({
        to_be_budgeted: 250000, // Only $250 available
      });

      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Bills", [
          {
            id: "cat-rent",
            name: "Rent",
            budgeted: 0,
            goal_type: "NEED",
            goal_under_funded: 200000, // $200
          },
          {
            id: "cat-electric",
            name: "Electric",
            budgeted: 0,
            goal_type: "NEED",
            goal_under_funded: 150000, // $150
          },
        ]),
      ]);

      const result = parseResult(
        await handler({ month: "2024-06-01", history_months: 1 }),
      );

      // Total needed: $350, only $250 available
      // Both are P1 sorted by needed ascending: Electric ($150) first, then Rent ($200)
      expect(result.total_allocated).toBe(250);
      expect(result.unallocated_remainder).toBe(0);

      // Electric fully funded ($150), Rent partially funded ($100)
      const electric = result.allocations.find(
        (a: Record<string, string>) => a.category_name === "Electric",
      );
      const rent = result.allocations.find(
        (a: Record<string, string>) => a.category_name === "Rent",
      );
      expect(electric.amount).toBe(150);
      expect(rent.amount).toBe(100);
    });

    it("uses custom available_amount when provided", async () => {
      ctx.ynabClient.getMonthSummary.mockResolvedValue({
        to_be_budgeted: 0, // RTA is zero
      });

      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Bills", [
          {
            id: "cat-rent",
            name: "Rent",
            budgeted: 0,
            goal_type: "NEED",
            goal_under_funded: 100000,
          },
        ]),
      ]);

      const result = parseResult(
        await handler({
          month: "2024-06-01",
          available_amount: 75,
          history_months: 1,
        }),
      );

      // Should use $75, not the $0 RTA
      expect(result.available_amount).toBe(75);
      expect(result.total_allocated).toBe(75);
    });
  });

  describe("set_budget_actions", () => {
    it("produces actions with currency unit amounts including existing budget", async () => {
      ctx.ynabClient.getMonthSummary.mockResolvedValue({
        to_be_budgeted: 300000, // $300
      });

      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Bills", [
          {
            id: "cat-rent",
            name: "Rent",
            budgeted: 200000, // already has $200 budgeted
            goal_type: "NEED",
            goal_under_funded: 100000, // needs $100 more
          },
        ]),
      ]);

      const result = parseResult(
        await handler({ month: "2024-06-01", history_months: 1 }),
      );

      expect(result.set_budget_actions).toHaveLength(1);
      expect(result.set_budget_actions[0].category_id).toBe("cat-rent");
      // New budgeted = existing $200 + allocated $100 = $300
      expect(result.set_budget_actions[0].budgeted).toBe(300);
      expect(result.set_budget_actions[0].month).toBe("2024-06-01");
    });
  });

  describe("zero available amount", () => {
    it("returns early with no allocations when RTA is zero", async () => {
      ctx.ynabClient.getMonthSummary.mockResolvedValue({
        to_be_budgeted: 0,
      });

      const result = parseResult(await handler({ month: "2024-06-01" }));

      expect(result.available_amount).toBe(0);
      expect(result.allocations).toHaveLength(0);
      expect(result.set_budget_actions).toHaveLength(0);
      expect(result.message).toContain("Nothing available");
    });

    it("returns early with message when RTA is negative", async () => {
      ctx.ynabClient.getMonthSummary.mockResolvedValue({
        to_be_budgeted: -50000,
      });

      const result = parseResult(await handler({ month: "2024-06-01" }));

      expect(result.available_amount).toBe(-50);
      expect(result.allocations).toHaveLength(0);
      expect(result.message).toContain("negative");
    });
  });

  describe("no underfunded categories", () => {
    it("returns empty allocations when all categories are fully funded", async () => {
      ctx.ynabClient.getMonthSummary.mockResolvedValue({
        to_be_budgeted: 500000,
      });

      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Bills", [
          {
            id: "cat-rent",
            name: "Rent",
            budgeted: 200000,
            balance: 200000,
            goal_type: "NEED",
            goal_under_funded: 0,
          },
          {
            id: "cat-electric",
            name: "Electric",
            budgeted: 100000,
            balance: 100000,
            goal_type: "MF",
            goal_under_funded: 0,
          },
        ]),
      ]);

      const result = parseResult(
        await handler({ month: "2024-06-01", history_months: 1 }),
      );

      expect(result.allocations).toHaveLength(0);
      expect(result.total_allocated).toBe(0);
      expect(result.unallocated_remainder).toBe(500);
    });
  });

  describe("NEED goals classification", () => {
    it("puts NEED goals with target date into P1", async () => {
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Bills", [
          {
            id: "cat-1",
            name: "Insurance",
            goal_type: "NEED",
            goal_under_funded: 100000,
            goal_target_date: "2024-06-20",
          },
        ]),
      ]);

      const result = parseResult(
        await handler({ month: "2024-06-01", history_months: 1 }),
      );

      expect(result.allocations[0].priority).toBe("P1_bills_due");
      expect(result.allocations[0].reason).toContain("Bill due");
    });

    it("puts NEED goals with scheduled transactions into P1", async () => {
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Bills", [
          {
            id: "cat-phone",
            name: "Phone Bill",
            goal_type: "NEED",
            goal_under_funded: 80000,
          },
        ]),
      ]);

      ctx.ynabClient.getScheduledTransactions.mockResolvedValue([
        { id: "st-1", category_id: "cat-phone", amount: -80000 },
      ]);

      const result = parseResult(
        await handler({ month: "2024-06-01", history_months: 1 }),
      );

      expect(result.allocations[0].priority).toBe("P1_bills_due");
      expect(result.allocations[0].reason).toContain("Scheduled transaction");
    });

    it("puts NEED goals without date or schedule into P1 as monthly need", async () => {
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Bills", [
          {
            id: "cat-gas",
            name: "Gasoline",
            goal_type: "NEED",
            goal_under_funded: 60000,
          },
        ]),
      ]);

      const result = parseResult(
        await handler({ month: "2024-06-01", history_months: 1 }),
      );

      expect(result.allocations[0].priority).toBe("P1_bills_due");
      expect(result.allocations[0].reason).toContain("Monthly NEED");
    });
  });

  describe("P4 savings proration", () => {
    it("prorates savings when insufficient funds remain", async () => {
      ctx.ynabClient.getMonthSummary.mockResolvedValue({
        to_be_budgeted: 100000, // Only $100 for savings
      });

      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Savings", [
          {
            id: "cat-vacation",
            name: "Vacation",
            goal_type: "TB",
            goal_under_funded: 200000, // needs $200
          },
          {
            id: "cat-emergency",
            name: "Emergency Fund",
            goal_type: "TBD",
            goal_under_funded: 300000, // needs $300
            goal_target_date: "2024-12-31",
          },
        ]),
      ]);

      const result = parseResult(
        await handler({ month: "2024-06-01", history_months: 1 }),
      );

      // Total savings needed = $500, available = $100
      // Vacation: 200/500 * 100000 = 40000 ($40)
      // Emergency: 300/500 * 100000 = 60000 ($60)
      const vacation = result.allocations.find(
        (a: Record<string, string>) => a.category_name === "Vacation",
      );
      const emergency = result.allocations.find(
        (a: Record<string, string>) => a.category_name === "Emergency Fund",
      );

      expect(vacation.priority).toBe("P4_savings");
      expect(emergency.priority).toBe("P4_savings");

      // Prorated amounts should roughly match proportions
      expect(vacation.amount).toBe(40);
      expect(emergency.amount).toBe(60);
      expect(result.unallocated_remainder).toBe(0);
    });

    it("fully funds savings when enough is available", async () => {
      ctx.ynabClient.getMonthSummary.mockResolvedValue({
        to_be_budgeted: 600000, // $600
      });

      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Savings", [
          {
            id: "cat-vacation",
            name: "Vacation",
            goal_type: "TB",
            goal_under_funded: 200000,
          },
        ]),
      ]);

      const result = parseResult(
        await handler({ month: "2024-06-01", history_months: 1 }),
      );

      expect(result.allocations[0].amount).toBe(200);
      expect(result.unallocated_remainder).toBe(400);
    });
  });

  describe("P3 variable spending via history", () => {
    it("suggests allocation for categories where historical avg exceeds balance", async () => {
      ctx.ynabClient.getMonthSummary.mockResolvedValue({
        to_be_budgeted: 300000,
      });

      ctx.ynabClient.getCategories.mockImplementation(
        async (_budgetId: unknown, opts?: { month?: string }) => {
          if (opts?.month === "2024-06-01") {
            return [
              makeGroup("Everyday", [
                {
                  id: "cat-coffee",
                  name: "Coffee Shops",
                  budgeted: 0,
                  balance: 10000, // $10 balance
                  activity: 0,
                  // No target - will be P3 candidate
                },
              ]),
            ];
          }
          // Historical months: $50 average spending
          return [
            makeGroup("Everyday", [
              {
                id: "cat-coffee",
                name: "Coffee Shops",
                activity: -50000,
              },
            ]),
          ];
        },
      );

      const result = parseResult(
        await handler({ month: "2024-06-01", history_months: 3 }),
      );

      // Gap = historical avg (50000) - balance (10000) = 40000 = $40
      const coffee = result.allocations.find(
        (a: Record<string, string>) => a.category_name === "Coffee Shops",
      );
      expect(coffee).toBeDefined();
      expect(coffee.priority).toBe("P3_variable_spending");
      expect(coffee.amount).toBe(40);
    });
  });

  describe("skips internal groups", () => {
    it("excludes Internal Master Category and Credit Card Payments", async () => {
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Internal Master Category", [
          {
            id: "int-1",
            name: "Internal",
            goal_type: "NEED",
            goal_under_funded: 99000,
          },
        ]),
        makeGroup(
          "Credit Card Payments",
          [
            {
              id: "cc-1",
              name: "Visa",
              goal_type: "MF",
              goal_under_funded: 50000,
            },
          ],
          "cc-group",
        ),
      ]);

      const result = parseResult(
        await handler({ month: "2024-06-01", history_months: 1 }),
      );

      expect(result.allocations).toHaveLength(0);
    });
  });

  describe("output structure", () => {
    it("returns all expected fields in the response", async () => {
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Bills", [
          {
            id: "cat-rent",
            name: "Rent",
            budgeted: 0,
            goal_type: "NEED",
            goal_under_funded: 100000,
          },
        ]),
      ]);

      const result = parseResult(
        await handler({ month: "2024-06-01", history_months: 1 }),
      );

      expect(result).toHaveProperty("budget_id");
      expect(result).toHaveProperty("month", "2024-06-01");
      expect(result).toHaveProperty("available_amount", 500);
      expect(result).toHaveProperty("available_amount_display", "$500.00");
      expect(result).toHaveProperty("total_allocated");
      expect(result).toHaveProperty("total_allocated_display");
      expect(result).toHaveProperty("unallocated_remainder");
      expect(result).toHaveProperty("unallocated_remainder_display");
      expect(result).toHaveProperty("allocation_count");
      expect(result).toHaveProperty("allocations");
      expect(result).toHaveProperty("set_budget_actions");

      const alloc = result.allocations[0];
      expect(alloc).toHaveProperty("category_id");
      expect(alloc).toHaveProperty("category_name");
      expect(alloc).toHaveProperty("group_name");
      expect(alloc).toHaveProperty("priority");
      expect(alloc).toHaveProperty("amount");
      expect(alloc).toHaveProperty("amount_display");
      expect(alloc).toHaveProperty("reason");
    });
  });
});
