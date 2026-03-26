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
  });

  it("falls back to tree category when month data is missing", async () => {
    const treeCat = {
      id: "cat-orphan",
      name: "Orphan",
      budgeted: 0,
      activity: 0,
      balance: 0,
    };
    ctx.ynabClient.getMonthSummary.mockResolvedValue({
      month: "2024-01-01",
      income: 0,
      budgeted: 0,
      activity: 0,
      to_be_budgeted: 0,
      age_of_money: null,
      categories: [], // month has no data for this category
    });
    ctx.ynabClient.getCategories.mockResolvedValue([
      {
        id: "group-1",
        name: "Group",
        categories: [treeCat],
      },
    ]);

    const handler = tools.get_monthly_budget;
    const result = parseResult(await handler({}));

    // Should fall back to treeCat values
    expect(result.groups[0].categories[0].name).toBe("Orphan");
    expect(result.groups[0].categories[0].budgeted).toBe(0);
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
