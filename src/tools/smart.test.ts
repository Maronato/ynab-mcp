import { describe, expect, it } from "vitest";
import type { PayeeProfile } from "../analysis/payee-profiles.js";
import {
  captureToolHandlers,
  createMockContext,
  createMockCurrencyFormat,
  createMockNameLookup,
  createMockTransaction,
} from "../test-utils.js";
import { registerSmartTools } from "./smart.js";

function setup() {
  const context = createMockContext();
  const handlers = captureToolHandlers(registerSmartTools, context);
  return { context, handlers };
}

function makeProfile(overrides: Partial<PayeeProfile> = {}): PayeeProfile {
  return {
    payee_id: "payee-1",
    payee_name: "Supermarket",
    category_counts: new Map(),
    recency_weighted: new Map(),
    total_count: 0,
    most_recent_category_id: null,
    most_recent_date: null,
    amount_buckets: [],
    ...overrides,
  };
}

function makeCategoryGroups() {
  return [
    {
      id: "group-1",
      name: "Bills",
      hidden: false,
      deleted: false,
      categories: [
        {
          id: "cat-electric",
          name: "Electric",
          hidden: false,
          deleted: false,
          budgeted: 100000,
          activity: -150000,
          balance: -50000,
          category_group_id: "group-1",
          goal_type: null,
          goal_target: null,
          goal_target_date: null,
          goal_percentage_complete: null,
        },
      ],
    },
    {
      id: "group-2",
      name: "Everyday",
      hidden: false,
      deleted: false,
      categories: [
        {
          id: "cat-groceries",
          name: "Groceries",
          hidden: false,
          deleted: false,
          budgeted: 500000,
          activity: -300000,
          balance: 200000,
          category_group_id: "group-2",
          goal_type: null,
          goal_target: null,
          goal_target_date: null,
          goal_percentage_complete: null,
        },
        {
          id: "cat-dining",
          name: "Dining Out",
          hidden: false,
          deleted: false,
          budgeted: 200000,
          activity: -100000,
          balance: 100000,
          category_group_id: "group-2",
          goal_type: null,
          goal_target: null,
          goal_target_date: null,
          goal_percentage_complete: null,
        },
      ],
    },
  ];
}

function setupDefaultMocks(context: ReturnType<typeof createMockContext>) {
  context.ynabClient.getCategories.mockResolvedValue(makeCategoryGroups());
  context.ynabClient.getNameLookup.mockResolvedValue(
    createMockNameLookup({
      categoryById: new Map([
        [
          "cat-groceries",
          { name: "Groceries", group_id: "group-2", group_name: "Everyday" },
        ],
        [
          "cat-dining",
          { name: "Dining Out", group_id: "group-2", group_name: "Everyday" },
        ],
        [
          "cat-electric",
          { name: "Electric", group_id: "group-1", group_name: "Bills" },
        ],
      ]),
    }),
  );
  context.ynabClient.getBudgetSettings.mockResolvedValue({
    currency_format: createMockCurrencyFormat(),
  });
  context.ynabClient.getScheduledTransactions.mockResolvedValue([]);
}

describe("suggest_transaction_categories", () => {
  it("returns early when no transactions to categorize", async () => {
    const { context, handlers } = setup();
    context.ynabClient.searchTransactions.mockResolvedValue([]);
    setupDefaultMocks(context);

    const result = await handlers.suggest_transaction_categories({
      budget_id: "budget-1",
    });
    const content = JSON.parse(result.content[0].text);

    expect(content.suggestion_count).toBe(0);
    expect(content.message).toContain("No transactions");
  });

  it("returns suggestions with confidence levels from payee history", async () => {
    const { context, handlers } = setup();
    const tx = createMockTransaction({
      id: "tx-1",
      category_id: null,
      payee_id: "payee-1",
      approved: false,
    });
    // First call = uncategorized, second call = unapproved
    context.ynabClient.searchTransactions
      .mockResolvedValueOnce([tx])
      .mockResolvedValueOnce([]);
    setupDefaultMocks(context);

    // Provide strong payee profile
    const profiles = new Map([
      [
        "payee-1",
        makeProfile({
          payee_id: "payee-1",
          payee_name: "Supermarket",
          category_counts: new Map([["cat-groceries", 20]]),
          recency_weighted: new Map([["cat-groceries", 15]]),
          total_count: 20,
        }),
      ],
    ]);
    context.payeeProfileAnalyzer.getProfiles.mockResolvedValue(profiles);

    const result = await handlers.suggest_transaction_categories({
      budget_id: "budget-1",
    });
    const content = JSON.parse(result.content[0].text);

    expect(content.suggestion_count).toBe(1);
    expect(content.confidence_summary.definitive).toBe(1);
    expect(content.suggestions[0].suggested_category_id).toBe("cat-groceries");
    expect(content.suggestions[0].suggested_category_group_name).toBe(
      "Everyday",
    );
    expect(content.suggestions[0].confidence).toBe("definitive");
    expect(content.update_actions).toEqual([
      { transaction_id: "tx-1", category_id: "cat-groceries", approved: true },
    ]);
  });

  it("includes unapproved YNAB-categorized transactions when enabled", async () => {
    const { context, handlers } = setup();
    const uncategorized = createMockTransaction({
      id: "tx-1",
      category_id: null,
      approved: false,
    });
    const unapprovedCategorized = createMockTransaction({
      id: "tx-2",
      category_id: "cat-dining",
      approved: false,
    });
    context.ynabClient.searchTransactions
      .mockResolvedValueOnce([uncategorized])
      .mockResolvedValueOnce([unapprovedCategorized]);
    setupDefaultMocks(context);
    context.payeeProfileAnalyzer.getProfiles.mockResolvedValue(new Map());

    const result = await handlers.suggest_transaction_categories({
      budget_id: "budget-1",
      include_unapproved: true,
    });
    const content = JSON.parse(result.content[0].text);

    expect(content.suggestion_count).toBe(2);
    // The unapproved one should have YNAB existing signal
    const unapprovedSuggestion = content.suggestions.find(
      (s: Record<string, unknown>) => s.transaction_id === "tx-2",
    );
    expect(unapprovedSuggestion.current_category_id).toBe("cat-dining");
  });

  it("does not mutate transactions (read-only)", async () => {
    const { context, handlers } = setup();
    const tx = createMockTransaction({
      id: "tx-1",
      category_id: null,
      payee_id: "payee-1",
    });
    context.ynabClient.searchTransactions
      .mockResolvedValueOnce([tx])
      .mockResolvedValueOnce([]);
    setupDefaultMocks(context);
    context.payeeProfileAnalyzer.getProfiles.mockResolvedValue(new Map());

    await handlers.suggest_transaction_categories({ budget_id: "budget-1" });

    expect(context.ynabClient.updateTransactions).not.toHaveBeenCalled();
    expect(context.ynabClient.createTransactions).not.toHaveBeenCalled();
    expect(context.ynabClient.deleteTransaction).not.toHaveBeenCalled();
    expect(context.undoEngine.recordEntries).not.toHaveBeenCalled();
  });

  it("enhances medium/low suggestions with LLM when sampling available", async () => {
    const { context, handlers } = setup();
    const tx = createMockTransaction({
      id: "tx-1",
      category_id: null,
      payee_id: "unknown-payee",
    });
    context.ynabClient.searchTransactions
      .mockResolvedValueOnce([tx])
      .mockResolvedValueOnce([]);
    setupDefaultMocks(context);
    context.payeeProfileAnalyzer.getProfiles.mockResolvedValue(new Map());
    context.samplingClient.isAvailable.mockReturnValue(true);
    context.samplingClient.createJsonMessage.mockResolvedValue([
      {
        transaction_id: "tx-1",
        category_id: "cat-groceries",
        confidence: "high",
        reasoning: "Payee name suggests grocery store",
      },
    ]);

    const result = await handlers.suggest_transaction_categories({
      budget_id: "budget-1",
    });
    const content = JSON.parse(result.content[0].text);

    expect(content.suggestions[0].suggested_category_id).toBe("cat-groceries");
    expect(content.suggestions[0].method).toContain("llm");
    expect(context.samplingClient.createJsonMessage).toHaveBeenCalled();
  });

  it("excludes transfers by default", async () => {
    const { context, handlers } = setup();
    context.ynabClient.searchTransactions.mockResolvedValue([]);
    setupDefaultMocks(context);

    await handlers.suggest_transaction_categories({
      budget_id: "budget-1",
    });

    for (const call of context.ynabClient.searchTransactions.mock.calls) {
      expect(call[1]).toHaveProperty("exclude_transfers", true);
    }
  });

  it("passes exclude_transfers=false when include_transfers is true", async () => {
    const { context, handlers } = setup();
    context.ynabClient.searchTransactions.mockResolvedValue([]);
    setupDefaultMocks(context);

    await handlers.suggest_transaction_categories({
      budget_id: "budget-1",
      include_transfers: true,
    });

    for (const call of context.ynabClient.searchTransactions.mock.calls) {
      expect(call[1]).toHaveProperty("exclude_transfers", false);
    }
  });

  it("includes approved uncategorized transactions by default", async () => {
    const { context, handlers } = setup();
    const approvedUncategorized = createMockTransaction({
      id: "tx-approved",
      category_id: null,
      approved: true,
    });
    const unapprovedUncategorized = createMockTransaction({
      id: "tx-unapproved",
      category_id: null,
      approved: false,
    });
    context.ynabClient.searchTransactions
      .mockResolvedValueOnce([approvedUncategorized, unapprovedUncategorized])
      .mockResolvedValueOnce([]);
    setupDefaultMocks(context);
    context.payeeProfileAnalyzer.getProfiles.mockResolvedValue(new Map());

    const result = await handlers.suggest_transaction_categories({
      budget_id: "budget-1",
    });
    const content = JSON.parse(result.content[0].text);

    expect(content.suggestion_count).toBe(2);
    const ids = content.suggestions.map(
      (s: { transaction_id: string }) => s.transaction_id,
    );
    expect(ids).toContain("tx-approved");
    expect(ids).toContain("tx-unapproved");
  });

  it("excludes approved uncategorized when include_approved_uncategorized is false", async () => {
    const { context, handlers } = setup();
    const approvedUncategorized = createMockTransaction({
      id: "tx-approved",
      category_id: null,
      approved: true,
    });
    const unapprovedUncategorized = createMockTransaction({
      id: "tx-unapproved",
      category_id: null,
      approved: false,
    });
    context.ynabClient.searchTransactions
      .mockResolvedValueOnce([approvedUncategorized, unapprovedUncategorized])
      .mockResolvedValueOnce([]);
    setupDefaultMocks(context);
    context.payeeProfileAnalyzer.getProfiles.mockResolvedValue(new Map());

    const result = await handlers.suggest_transaction_categories({
      budget_id: "budget-1",
      include_approved_uncategorized: false,
    });
    const content = JSON.parse(result.content[0].text);

    expect(content.suggestion_count).toBe(1);
    expect(content.suggestions[0].transaction_id).toBe("tx-unapproved");
  });

  it("omits approved field from update_actions when approve is false", async () => {
    const { context, handlers } = setup();
    const tx = createMockTransaction({
      id: "tx-1",
      category_id: null,
      payee_id: "payee-1",
      approved: false,
    });
    context.ynabClient.searchTransactions
      .mockResolvedValueOnce([tx])
      .mockResolvedValueOnce([]);
    setupDefaultMocks(context);
    const profiles = new Map([
      [
        "payee-1",
        makeProfile({
          payee_id: "payee-1",
          category_counts: new Map([["cat-groceries", 20]]),
          recency_weighted: new Map([["cat-groceries", 15]]),
          total_count: 20,
        }),
      ],
    ]);
    context.payeeProfileAnalyzer.getProfiles.mockResolvedValue(profiles);

    const result = await handlers.suggest_transaction_categories({
      budget_id: "budget-1",
      approve: false,
    });
    const content = JSON.parse(result.content[0].text);

    expect(content.update_actions[0].approved).toBeUndefined();
    expect(content.update_actions[0].transaction_id).toBe("tx-1");
    expect(content.update_actions[0].category_id).toBe("cat-groceries");
  });

  it("returns suggestions without LLM when sampling unavailable", async () => {
    const { context, handlers } = setup();
    const tx = createMockTransaction({
      id: "tx-1",
      category_id: null,
      payee_id: "unknown-payee",
    });
    context.ynabClient.searchTransactions
      .mockResolvedValueOnce([tx])
      .mockResolvedValueOnce([]);
    setupDefaultMocks(context);
    context.payeeProfileAnalyzer.getProfiles.mockResolvedValue(new Map());
    context.samplingClient.isAvailable.mockReturnValue(false);

    const result = await handlers.suggest_transaction_categories({
      budget_id: "budget-1",
    });
    const content = JSON.parse(result.content[0].text);

    // Should still return suggestions (server-side analysis), just without LLM enhancement
    expect(content.suggestion_count).toBe(1);
    expect(context.samplingClient.createJsonMessage).not.toHaveBeenCalled();
  });
});

describe("suggest_overspending_coverage", () => {
  it("returns early when no overspent categories", async () => {
    const { context, handlers } = setup();
    const groups = makeCategoryGroups();
    groups[0].categories[0].balance = 0;
    context.ynabClient.getCategories.mockResolvedValue(groups);
    context.ynabClient.getBudgetSettings.mockResolvedValue({
      currency_format: createMockCurrencyFormat(),
    });

    const result = await handlers.suggest_overspending_coverage({
      budget_id: "budget-1",
    });
    const content = JSON.parse(result.content[0].text);

    expect(content.overspent_count).toBe(0);
    expect(content.message).toContain("No overspent");
  });

  it("returns deterministic suggestions when sampling unavailable", async () => {
    const { context, handlers } = setup();
    context.ynabClient.getCategories.mockResolvedValue(makeCategoryGroups());
    context.ynabClient.getBudgetSettings.mockResolvedValue({
      currency_format: createMockCurrencyFormat(),
    });
    context.samplingClient.isAvailable.mockReturnValue(false);
    context.ynabClient.getMonthCategoryById.mockImplementation(
      async (_budgetId: string, _month: string, catId: string) => {
        const cats: Record<string, { id: string; budgeted: number }> = {
          "cat-groceries": { id: "cat-groceries", budgeted: 500000 },
          "cat-electric": { id: "cat-electric", budgeted: 100000 },
        };
        return cats[catId] ?? null;
      },
    );

    const result = await handlers.suggest_overspending_coverage({
      budget_id: "budget-1",
    });
    const content = JSON.parse(result.content[0].text);

    expect(content.sampling_available).toBe(false);
    expect(content.suggestion_count).toBeGreaterThan(0);
    expect(content.suggestions[0].from_category_id).toBe("cat-groceries");
    expect(content.suggestions[0].to_category_id).toBe("cat-electric");
    expect(content.suggestions[0].amount).toBe(50);
    expect(content.set_budget_actions).toBeDefined();
    expect(content.set_budget_actions.length).toBeGreaterThan(0);
  });

  it("returns suggestions with set_budget_actions (read-only)", async () => {
    const { context, handlers } = setup();
    context.ynabClient.getCategories.mockResolvedValue(makeCategoryGroups());
    context.ynabClient.getBudgetSettings.mockResolvedValue({
      currency_format: createMockCurrencyFormat(),
    });
    context.samplingClient.isAvailable.mockReturnValue(true);
    context.samplingClient.createJsonMessage.mockResolvedValue([
      {
        from_category_id: "cat-groceries",
        to_category_id: "cat-electric",
        amount: 50,
        reasoning: "Cover electric bill",
      },
    ]);
    context.ynabClient.getMonthCategoryById.mockImplementation(
      async (_budgetId: string, _month: string, catId: string) => {
        const cats: Record<string, { id: string; budgeted: number }> = {
          "cat-groceries": { id: "cat-groceries", budgeted: 500000 },
          "cat-electric": { id: "cat-electric", budgeted: 100000 },
        };
        return cats[catId] ?? null;
      },
    );

    const result = await handlers.suggest_overspending_coverage({
      budget_id: "budget-1",
    });
    const content = JSON.parse(result.content[0].text);

    expect(content.suggestion_count).toBe(1);
    expect(content.suggestions[0].from_category_name).toBe("Groceries");
    expect(content.suggestions[0].to_category_name).toBe("Electric");
    expect(content.set_budget_actions).toBeDefined();
    expect(content.set_budget_actions.length).toBeGreaterThan(0);

    // Should NOT have mutated anything
    expect(context.ynabClient.setCategoryBudget).not.toHaveBeenCalled();
    expect(context.undoEngine.recordEntries).not.toHaveBeenCalled();
  });

  it("skips suggestions that exceed source balance", async () => {
    const { context, handlers } = setup();
    context.ynabClient.getCategories.mockResolvedValue(makeCategoryGroups());
    context.ynabClient.getBudgetSettings.mockResolvedValue({
      currency_format: createMockCurrencyFormat(),
    });
    context.samplingClient.isAvailable.mockReturnValue(true);
    context.samplingClient.createJsonMessage.mockResolvedValue([
      {
        from_category_id: "cat-groceries",
        to_category_id: "cat-electric",
        amount: 9999,
        reasoning: "Way too much",
      },
    ]);

    const result = await handlers.suggest_overspending_coverage({
      budget_id: "budget-1",
    });
    const content = JSON.parse(result.content[0].text);

    expect(content.suggestion_count).toBe(0);
    expect(content.skipped_count).toBe(1);
  });

  it("returns error when sampling fails", async () => {
    const { context, handlers } = setup();
    context.ynabClient.getCategories.mockResolvedValue(makeCategoryGroups());
    context.ynabClient.getBudgetSettings.mockResolvedValue({
      currency_format: createMockCurrencyFormat(),
    });
    context.samplingClient.isAvailable.mockReturnValue(true);
    context.samplingClient.createJsonMessage.mockRejectedValue(
      new Error("Parse error"),
    );

    const result = await handlers.suggest_overspending_coverage({
      budget_id: "budget-1",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Parse error");
  });
});
