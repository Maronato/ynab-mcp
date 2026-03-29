import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./harness.js";
import { CURRENT_MONTH, seedStandardBudget } from "./seed.js";

let harness: IntegrationHarness;

beforeEach(async () => {
  harness = await createIntegrationHarness({ seed: seedStandardBudget });
});

afterEach(async () => {
  await harness.close();
});

describe("list_categories", () => {
  it("returns category groups with categories from seed data", async () => {
    const result = (await harness.callTool("list_categories", {})) as {
      groups: Array<{
        id: string;
        name: string;
        categories: Array<{ id: string; name: string }>;
      }>;
    };

    expect(result.groups.length).toBeGreaterThanOrEqual(3);

    const everyday = result.groups.find((g) => g.name === "Everyday Expenses");
    expect(everyday).toBeDefined();
    expect(everyday?.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "cat-groceries", name: "Groceries" }),
        expect.objectContaining({ id: "cat-dining", name: "Dining Out" }),
        expect.objectContaining({
          id: "cat-transport",
          name: "Transportation",
        }),
      ]),
    );

    const bills = result.groups.find((g) => g.name === "Monthly Bills");
    expect(bills).toBeDefined();
    expect(bills?.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "cat-rent", name: "Rent/Mortgage" }),
      ]),
    );
  });
});

describe("set_category_budgets", () => {
  it("sets a budgeted amount and returns updated value", async () => {
    // Capture original budgeted amount
    const before = (await harness.callTool("get_monthly_budget", {
      month: CURRENT_MONTH,
    })) as {
      groups: Array<{
        categories: Array<{ id: string; budgeted: number }>;
      }>;
    };
    const originalBudgeted = before.groups
      .flatMap((g) => g.categories)
      .find((c) => c.id === "cat-groceries")?.budgeted;
    expect(originalBudgeted).toBeDefined();

    const result = (await harness.callTool("set_category_budgets", {
      assignments: [
        {
          category_id: "cat-groceries",
          month: CURRENT_MONTH,
          budgeted: 500.0,
        },
      ],
    })) as {
      results: Array<{
        status: string;
        updated_budgeted: number;
        previous_budgeted: number;
      }>;
      undo_history_ids: string[];
    };

    expect(result.results[0].status).toBe("updated");
    expect(result.results[0].updated_budgeted).toBe(500.0);
    expect(result.results[0].previous_budgeted).toBe(originalBudgeted);
    expect(result.undo_history_ids).toHaveLength(1);

    // Verify the update is reflected in get_monthly_budget
    const after = (await harness.callTool("get_monthly_budget", {
      month: CURRENT_MONTH,
    })) as {
      groups: Array<{
        categories: Array<{ id: string; budgeted: number }>;
      }>;
    };
    const updatedBudgeted = after.groups
      .flatMap((g) => g.categories)
      .find((c) => c.id === "cat-groceries")?.budgeted;
    expect(updatedBudgeted).toBe(500.0);

    // Undo it
    const undone = (await harness.callTool("undo_operations", {
      undo_history_ids: result.undo_history_ids,
    })) as { results: Array<{ status: string }> };

    expect(undone.results[0].status).toBe("undone");

    // Verify undo reverted the budget
    const reverted = (await harness.callTool("get_monthly_budget", {
      month: CURRENT_MONTH,
    })) as {
      groups: Array<{
        categories: Array<{ id: string; budgeted: number }>;
      }>;
    };
    const revertedBudgeted = reverted.groups
      .flatMap((g) => g.categories)
      .find((c) => c.id === "cat-groceries")?.budgeted;
    expect(revertedBudgeted).toBe(originalBudgeted);
  });
});

describe("get_monthly_budget", () => {
  it("returns month data with categories for the current month", async () => {
    const result = (await harness.callTool("get_monthly_budget", {
      month: CURRENT_MONTH,
    })) as {
      month: string;
      income: number;
      income_display: string;
      budgeted: number;
      activity: number;
      to_be_budgeted: number;
      age_of_money: number | null;
      groups: Array<{
        id: string;
        name: string;
        categories: Array<{
          id: string;
          name: string;
          budgeted: number;
          budgeted_display: string;
          activity: number;
          balance: number;
          overspent: boolean;
        }>;
      }>;
    };

    expect(result.month).toBe(CURRENT_MONTH);
    // Seed values: income=6000000mu => 6000.0, budgeted=3160000mu => 3160.0
    expect(result.income).toBe(6000.0);
    expect(result.income_display).toBe("$6,000.00");
    expect(result.budgeted).toBe(3160.0);
    expect(result.activity).toBe(-3655.0);
    expect(result.to_be_budgeted).toBe(2840.0);
    expect(result.age_of_money).toBe(45);
    expect(result.groups.length).toBeGreaterThanOrEqual(3);

    // Verify specific category values from seed
    const allCategories = result.groups.flatMap((g) => g.categories);
    const groceries = allCategories.find((c) => c.id === "cat-groceries");
    expect(groceries).toBeDefined();
    expect(groceries?.name).toBe("Groceries");
    // Seed: budgeted=400000mu => 400.0, activity=-250000mu => -250.0
    expect(groceries?.budgeted).toBe(400.0);
    expect(groceries?.activity).toBe(-250.0);
    expect(groceries?.balance).toBe(150.0);
    expect(groceries?.overspent).toBe(false);
  });
});
