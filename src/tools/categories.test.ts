import { beforeEach, describe, expect, it } from "vitest";
import type { MockAppContext } from "../test-utils.js";
import { captureToolHandlers, createMockContext } from "../test-utils.js";
import { registerCategoryTools } from "./categories.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

let ctx: MockAppContext;
let tools: Record<string, ToolHandler>;

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  ctx = createMockContext();
  tools = captureToolHandlers(registerCategoryTools, ctx) as Record<
    string,
    ToolHandler
  >;

  ctx.ynabClient.getBudgetSettings.mockResolvedValue({
    currency_format: {},
  });
});

describe("list_categories", () => {
  it("returns group hierarchy with self-contained category identity", async () => {
    ctx.ynabClient.getCategories.mockResolvedValue([
      {
        id: "group-1",
        name: "Everyday",
        hidden: false,
        categories: [
          { id: "cat-1", name: "Groceries", hidden: false },
          { id: "cat-2", name: "Dining", hidden: true },
        ],
      },
    ]);

    const handler = tools.list_categories;
    const result = parseResult(await handler({}));

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].id).toBe("group-1");
    expect(result.groups[0].name).toBe("Everyday");
    expect(result.groups[0].categories).toHaveLength(2);
    expect(result.groups[0].categories[0]).toEqual({
      id: "cat-1",
      name: "Groceries",
      category_group_id: "group-1",
      category_group_name: "Everyday",
      hidden: false,
    });
  });

  it("does not include budget or target fields", async () => {
    ctx.ynabClient.getCategories.mockResolvedValue([
      {
        id: "group-1",
        name: "Group",
        hidden: false,
        categories: [
          {
            id: "cat-1",
            name: "Cat",
            hidden: false,
            budgeted: 50000,
            activity: -20000,
            balance: 30000,
            goal_type: "TB",
          },
        ],
      },
    ]);

    const handler = tools.list_categories;
    const result = parseResult(await handler({}));

    const cat = result.groups[0].categories[0];
    expect(cat.budgeted).toBeUndefined();
    expect(cat.activity).toBeUndefined();
    expect(cat.balance).toBeUndefined();
    expect(cat.goal_type).toBeUndefined();
    expect(cat.target_type).toBeUndefined();
  });

  it("passes group_id and include_hidden to client", async () => {
    ctx.ynabClient.getCategories.mockResolvedValue([]);

    const handler = tools.list_categories;
    await handler({ group_id: "g-1", include_hidden: true });

    expect(ctx.ynabClient.getCategories).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        groupId: "g-1",
        includeHidden: true,
      }),
    );
  });
});

describe("get_targets", () => {
  it("returns categories with target_* field naming", async () => {
    ctx.ynabClient.getCategories.mockResolvedValue([
      {
        id: "group-1",
        name: "Bills",
        hidden: false,
        categories: [
          {
            id: "cat-1",
            name: "Rent",
            hidden: false,
            budgeted: 430000,
            activity: -430000,
            balance: 0,
            goal_type: "NEED",
            goal_needs_whole_amount: true,
            goal_target: 430000,
            goal_target_date: "2024-02-10",
            goal_months_to_budget: 1,
            goal_under_funded: 430000,
            goal_overall_funded: 0,
            goal_percentage_complete: 100,
          },
        ],
      },
    ]);

    const handler = tools.get_targets;
    const result = parseResult(await handler({}));

    const cat = result.groups[0].categories[0];
    expect(cat.target_type).toBe("NEED");
    expect(cat.target_needs_whole_amount).toBe(true);
    expect(cat.target_amount).toBe(430);
    expect(cat.target_date).toBe("2024-02-10");
    expect(cat.target_months_to_budget).toBe(1);
    expect(cat.target_underfunded).toBe(430);
    expect(cat.target_overall_funded).toBe(0);
    expect(cat.target_percentage_complete).toBe(100);
    expect(cat.category_group_id).toBe("group-1");
    expect(cat.category_group_name).toBe("Bills");

    expect(cat.goal_type).toBeUndefined();
    expect(cat.goal_target).toBeUndefined();
    expect(cat.budgeted).toBeUndefined();
    expect(cat.activity).toBeUndefined();
    expect(cat.balance).toBeUndefined();
  });

  it("returns null target fields for categories without targets", async () => {
    ctx.ynabClient.getCategories.mockResolvedValue([
      {
        id: "group-1",
        name: "Everyday",
        hidden: false,
        categories: [
          {
            id: "cat-1",
            name: "Groceries",
            hidden: false,
            budgeted: 50000,
            activity: -30000,
            balance: 20000,
            goal_type: null,
            goal_needs_whole_amount: null,
            goal_target: null,
            goal_target_date: null,
            goal_months_to_budget: null,
            goal_under_funded: null,
            goal_overall_funded: null,
            goal_percentage_complete: null,
          },
        ],
      },
    ]);

    const handler = tools.get_targets;
    const result = parseResult(await handler({}));

    const cat = result.groups[0].categories[0];
    expect(cat.target_type).toBeNull();
    expect(cat.target_needs_whole_amount).toBeNull();
    expect(cat.target_amount).toBeNull();
    expect(cat.target_amount_display).toBeNull();
    expect(cat.target_date).toBeNull();
    expect(cat.target_months_to_budget).toBeNull();
    expect(cat.target_underfunded).toBeNull();
    expect(cat.target_underfunded_display).toBeNull();
    expect(cat.target_overall_funded).toBeNull();
    expect(cat.target_overall_funded_display).toBeNull();
    expect(cat.target_percentage_complete).toBeNull();
  });

  it("passes month to client for scoped progress", async () => {
    ctx.ynabClient.getCategories.mockResolvedValue([]);

    const handler = tools.get_targets;
    await handler({ month: "2024-06-01" });

    expect(ctx.ynabClient.getCategories).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ month: "2024-06-01" }),
    );
  });
});

describe("get_monthly_budget", () => {
  it("joins month categories with category tree structure", async () => {
    const monthCategory = {
      id: "cat-1",
      name: "Groceries",
      budgeted: 50000,
      activity: -30000,
      balance: 20000,
    };
    ctx.ynabClient.getMonthSummary.mockResolvedValue({
      month: "2024-01-01",
      income: 500000,
      budgeted: 50000,
      activity: -30000,
      to_be_budgeted: 450000,
      age_of_money: 30,
      categories: [monthCategory],
    });
    ctx.ynabClient.getCategories.mockResolvedValue([
      {
        id: "group-1",
        name: "Everyday",
        categories: [{ id: "cat-1", name: "Groceries" }],
      },
    ]);

    const handler = tools.get_monthly_budget;
    const result = parseResult(await handler({}));

    expect(result.groups[0].categories[0].budgeted).toBe(50);
    expect(result.groups[0].categories[0].activity).toBe(-30);
    expect(result.groups[0].categories[0].balance).toBe(20);
    expect(result.groups[0].categories[0].category_group_id).toBe("group-1");
    expect(result.groups[0].categories[0].category_group_name).toBe("Everyday");
  });

  it("shows zeroes for categories missing from month data (never truncates)", async () => {
    ctx.ynabClient.getMonthSummary.mockResolvedValue({
      month: "2024-01-01",
      income: 0,
      budgeted: 0,
      activity: 0,
      to_be_budgeted: 0,
      age_of_money: null,
      categories: [],
    });
    ctx.ynabClient.getCategories.mockResolvedValue([
      {
        id: "group-1",
        name: "Group",
        categories: [
          { id: "cat-rent", name: "Rent" },
          { id: "cat-utils", name: "Utilities" },
        ],
      },
    ]);

    const handler = tools.get_monthly_budget;
    const result = parseResult(await handler({}));

    expect(result.groups[0].categories).toHaveLength(2);
    for (const cat of result.groups[0].categories) {
      expect(cat.budgeted).toBe(0);
      expect(cat.activity).toBe(0);
      expect(cat.balance).toBe(0);
      expect(cat.overspent).toBe(false);
    }
  });

  it("computes overspent flag correctly", async () => {
    ctx.ynabClient.getMonthSummary.mockResolvedValue({
      month: "2024-01-01",
      income: 0,
      budgeted: 0,
      activity: 0,
      to_be_budgeted: 0,
      age_of_money: null,
      categories: [
        {
          id: "cat-over",
          name: "Over",
          budgeted: 10000,
          activity: -20000,
          balance: -10000,
        },
        {
          id: "cat-ok",
          name: "OK",
          budgeted: 50000,
          activity: -10000,
          balance: 40000,
        },
      ],
    });
    ctx.ynabClient.getCategories.mockResolvedValue([
      {
        id: "group-1",
        name: "Group",
        categories: [
          { id: "cat-over", name: "Over" },
          { id: "cat-ok", name: "OK" },
        ],
      },
    ]);

    const handler = tools.get_monthly_budget;
    const result = parseResult(await handler({}));

    const cats = result.groups[0].categories;
    expect(
      cats.find((c: { name: string }) => c.name === "Over").overspent,
    ).toBe(true);
    expect(cats.find((c: { name: string }) => c.name === "OK").overspent).toBe(
      false,
    );
  });

  it("includes month summary totals", async () => {
    ctx.ynabClient.getMonthSummary.mockResolvedValue({
      month: "2024-01-01",
      income: 500000,
      budgeted: 400000,
      activity: -350000,
      to_be_budgeted: 100000,
      age_of_money: 45,
      categories: [],
    });
    ctx.ynabClient.getCategories.mockResolvedValue([]);

    const handler = tools.get_monthly_budget;
    const result = parseResult(await handler({}));

    expect(result.income).toBe(500);
    expect(result.budgeted).toBe(400);
    expect(result.activity).toBe(-350);
    expect(result.to_be_budgeted).toBe(100);
    expect(result.age_of_money).toBe(45);
  });

  it("does not include target fields", async () => {
    ctx.ynabClient.getMonthSummary.mockResolvedValue({
      month: "2024-01-01",
      income: 0,
      budgeted: 0,
      activity: 0,
      to_be_budgeted: 0,
      age_of_money: null,
      categories: [
        {
          id: "cat-1",
          name: "Rent",
          budgeted: 430000,
          activity: 0,
          balance: 430000,
        },
      ],
    });
    ctx.ynabClient.getCategories.mockResolvedValue([
      {
        id: "group-1",
        name: "Group",
        categories: [{ id: "cat-1", name: "Rent" }],
      },
    ]);

    const handler = tools.get_monthly_budget;
    const result = parseResult(await handler({}));

    const cat = result.groups[0].categories[0];
    expect(cat.target_type).toBeUndefined();
    expect(cat.goal_type).toBeUndefined();
  });

  it("passes include_hidden to client for uncommon hidden-category workflows", async () => {
    ctx.ynabClient.getMonthSummary.mockResolvedValue({
      month: "2024-01-01",
      income: 0,
      budgeted: 0,
      activity: 0,
      to_be_budgeted: 0,
      age_of_money: null,
      categories: [],
    });
    ctx.ynabClient.getCategories.mockResolvedValue([]);

    const handler = tools.get_monthly_budget;
    await handler({ include_hidden: true });

    expect(ctx.ynabClient.getCategories).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ includeHidden: true }),
    );
  });
});

describe("set_category_budgets", () => {
  it("prefetches and builds undo with before/after snapshots", async () => {
    const before = { id: "cat-1", budgeted: 50000 };
    const after = { id: "cat-1", budgeted: 100000 };
    ctx.ynabClient.getMonthCategoryById.mockResolvedValue(before);
    ctx.ynabClient.setCategoryBudget.mockResolvedValue(after);
    ctx.undoEngine.recordEntries.mockResolvedValue([{ id: "u1" }]);

    const handler = tools.set_category_budgets;
    const result = parseResult(
      await handler({
        assignments: [
          { category_id: "cat-1", month: "2024-01-01", budgeted: 100 },
        ],
      }),
    );

    expect(result.results[0].status).toBe("updated");
    expect(result.results[0].previous_budgeted_milliunits).toBe(50000);
    expect(result.results[0].updated_budgeted_milliunits).toBe(100000);

    const entries = ctx.undoEngine.recordEntries.mock.calls[0][1];
    expect(entries[0].undo_action.expected_state.budgeted).toBe(100000);
    expect(entries[0].undo_action.restore_state.budgeted).toBe(50000);
  });

  it("uses correct entity_id format: month:category_id", async () => {
    ctx.ynabClient.getMonthCategoryById.mockResolvedValue({
      id: "cat-1",
      budgeted: 0,
    });
    ctx.ynabClient.setCategoryBudget.mockResolvedValue({
      id: "cat-1",
      budgeted: 50000,
    });
    ctx.undoEngine.recordEntries.mockResolvedValue([{ id: "u1" }]);

    const handler = tools.set_category_budgets;
    await handler({
      assignments: [
        { category_id: "cat-1", month: "2024-03-01", budgeted: 50 },
      ],
    });

    const entries = ctx.undoEngine.recordEntries.mock.calls[0][1];
    expect(entries[0].undo_action.entity_id).toBe("2024-03-01:cat-1");
  });

  it("reports error when category/month not found", async () => {
    ctx.ynabClient.getMonthCategoryById.mockResolvedValue(null);

    const handler = tools.set_category_budgets;
    const result = parseResult(
      await handler({
        assignments: [
          { category_id: "cat-missing", month: "2024-01-01", budgeted: 50 },
        ],
      }),
    );

    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toContain("not found");
  });

  it("handles per-item errors without blocking others", async () => {
    ctx.ynabClient.getMonthCategoryById
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "cat-2", budgeted: 0 });
    ctx.ynabClient.setCategoryBudget.mockResolvedValue({
      id: "cat-2",
      budgeted: 50000,
    });
    ctx.undoEngine.recordEntries.mockResolvedValue([{ id: "u1" }]);

    const handler = tools.set_category_budgets;
    const result = parseResult(
      await handler({
        assignments: [
          { category_id: "cat-missing", month: "2024-01-01", budgeted: 50 },
          { category_id: "cat-2", month: "2024-01-01", budgeted: 50 },
        ],
      }),
    );

    expect(result.results).toHaveLength(2);
    expect(result.results[0].status).toBe("error");
    expect(result.results[1].status).toBe("updated");
  });
});
