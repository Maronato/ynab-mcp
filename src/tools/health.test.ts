import { beforeEach, describe, expect, it } from "vitest";
import type { MockAppContext } from "../test-utils.js";
import { captureToolHandlers, createMockContext } from "../test-utils.js";
import { registerHealthTools } from "./health.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

let ctx: MockAppContext;
let handler: ToolHandler;

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/** Helper: a minimal category group matching what the handler expects. */
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
      goal_target: null,
      ...c,
    })),
  };
}

function setupDefaults() {
  ctx.ynabClient.getMonthSummary.mockResolvedValue({
    to_be_budgeted: 0,
    age_of_money: 45,
    categories: [],
  });
  ctx.ynabClient.getAccounts.mockResolvedValue([]);
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
  ctx.ynabClient.searchTransactions.mockResolvedValue([]);
}

beforeEach(() => {
  ctx = createMockContext();
  const tools = captureToolHandlers(registerHealthTools, ctx) as Record<
    string,
    ToolHandler
  >;
  handler = tools.get_budget_health;
  setupDefaults();
});

describe("get_budget_health", () => {
  describe("output structure", () => {
    it("returns all expected top-level sections", async () => {
      const result = parseResult(await handler({ month: "2024-06-01" }));

      expect(result).toHaveProperty("budget_id");
      expect(result).toHaveProperty("month", "2024-06-01");
      expect(result).toHaveProperty("ready_to_assign");
      expect(result).toHaveProperty("overspending");
      expect(result).toHaveProperty("underfunded_targets");
      expect(result).toHaveProperty("credit_card_gaps");
      expect(result).toHaveProperty("uncategorized_count");
      expect(result).toHaveProperty("unapproved_count");
      expect(result).toHaveProperty("age_of_money");
      expect(result).toHaveProperty("issues");
    });

    it("returns ready_to_assign with amount, display, and status", async () => {
      ctx.ynabClient.getMonthSummary.mockResolvedValue({
        to_be_budgeted: 150000,
        age_of_money: 30,
      });

      const result = parseResult(await handler({ month: "2024-06-01" }));

      expect(result.ready_to_assign.amount).toBe(150);
      expect(result.ready_to_assign.display).toBe("$150.00");
      expect(result.ready_to_assign.status).toBe("positive");
    });
  });

  describe("ready_to_assign status", () => {
    it("classifies positive RTA", async () => {
      ctx.ynabClient.getMonthSummary.mockResolvedValue({
        to_be_budgeted: 50000,
        age_of_money: null,
      });

      const result = parseResult(await handler({ month: "2024-06-01" }));
      expect(result.ready_to_assign.status).toBe("positive");
    });

    it("classifies zero RTA", async () => {
      ctx.ynabClient.getMonthSummary.mockResolvedValue({
        to_be_budgeted: 0,
        age_of_money: null,
      });

      const result = parseResult(await handler({ month: "2024-06-01" }));
      expect(result.ready_to_assign.status).toBe("zero");
    });

    it("classifies negative RTA", async () => {
      ctx.ynabClient.getMonthSummary.mockResolvedValue({
        to_be_budgeted: -25000,
        age_of_money: null,
      });

      const result = parseResult(await handler({ month: "2024-06-01" }));
      expect(result.ready_to_assign.status).toBe("negative");
      expect(result.ready_to_assign.amount).toBe(-25);
    });
  });

  describe("overspent categories", () => {
    it("detects overspent categories as cash type by default", async () => {
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Everyday", [
          { id: "cat-groceries", name: "Groceries", balance: -35000 },
          { id: "cat-dining", name: "Dining Out", balance: -15000 },
        ]),
      ]);

      const result = parseResult(await handler({ month: "2024-06-01" }));

      expect(result.overspending.categories).toHaveLength(2);
      expect(result.overspending.total_cash).toBe(50);
      expect(result.overspending.total_credit).toBe(0);

      const groceries = result.overspending.categories.find(
        (c: Record<string, unknown>) => c.name === "Groceries",
      );
      expect(groceries.balance).toBe(-35);
      expect(groceries.type).toBe("cash");
      expect(groceries.group_name).toBe("Everyday");
    });

    it("reclassifies overspending as credit when credit card gaps exist", async () => {
      // A credit card with a gap triggers credit reclassification
      ctx.ynabClient.getAccounts.mockResolvedValue([
        {
          id: "cc-acc-1",
          name: "Visa Card",
          type: "creditCard",
          balance: -200000, // owes $200
          closed: false,
        },
      ]);
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Everyday", [
          { id: "cat-groceries", name: "Groceries", balance: -50000 },
        ]),
        makeGroup(
          "Credit Card Payments",
          [{ id: "cc-cat-1", name: "Visa Card", balance: 100000 }],
          "cc-group",
        ),
      ]);

      const result = parseResult(await handler({ month: "2024-06-01" }));

      // Gap = |−200000| − 100000 = 100000 ($100 gap)
      expect(result.credit_card_gaps).toHaveLength(1);
      expect(result.credit_card_gaps[0].gap).toBe(100);
      expect(result.credit_card_gaps[0].account_name).toBe("Visa Card");

      // The $50 overspend should be reclassified as credit since
      // the credit card gap pool ($100) covers it entirely
      const groceries = result.overspending.categories.find(
        (c: Record<string, unknown>) => c.name === "Groceries",
      );
      expect(groceries.type).toBe("credit");
      expect(result.overspending.total_credit).toBe(50);
      expect(result.overspending.total_cash).toBe(0);
    });

    it("skips hidden and deleted categories", async () => {
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Everyday", [
          { id: "cat-1", name: "Groceries", balance: -20000, hidden: true },
          { id: "cat-2", name: "Dining", balance: -10000, deleted: true },
          { id: "cat-3", name: "Fun Money", balance: 5000 },
        ]),
      ]);

      const result = parseResult(await handler({ month: "2024-06-01" }));
      expect(result.overspending.categories).toHaveLength(0);
    });

    it("skips internal category groups", async () => {
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Internal Master Category", [
          { id: "cat-internal", name: "Uncategorized", balance: -99000 },
        ]),
      ]);

      const result = parseResult(await handler({ month: "2024-06-01" }));
      expect(result.overspending.categories).toHaveLength(0);
    });
  });

  describe("underfunded targets", () => {
    it("detects underfunded categories and sums totals", async () => {
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Bills", [
          {
            id: "cat-rent",
            name: "Rent",
            goal_type: "NEED",
            goal_under_funded: 200000,
          },
          {
            id: "cat-electric",
            name: "Electric",
            goal_type: "NEED",
            goal_under_funded: 75000,
          },
        ]),
      ]);

      const result = parseResult(await handler({ month: "2024-06-01" }));

      expect(result.underfunded_targets.count).toBe(2);
      expect(result.underfunded_targets.total).toBe(275);
      expect(result.underfunded_targets.top_underfunded).toHaveLength(2);

      // Should be sorted descending by underfunded amount
      expect(result.underfunded_targets.top_underfunded[0].name).toBe("Rent");
      expect(result.underfunded_targets.top_underfunded[0].underfunded).toBe(
        200,
      );
      expect(result.underfunded_targets.top_underfunded[0].target_type).toBe(
        "NEED",
      );
      expect(result.underfunded_targets.top_underfunded[1].name).toBe(
        "Electric",
      );
    });

    it("ignores categories with null or zero underfunding", async () => {
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Bills", [
          {
            id: "cat-rent",
            name: "Rent",
            goal_type: "NEED",
            goal_under_funded: 0,
          },
          {
            id: "cat-water",
            name: "Water",
            goal_type: "MF",
            goal_under_funded: null,
          },
          {
            id: "cat-gas",
            name: "Gas",
            goal_type: "NEED",
          },
        ]),
      ]);

      const result = parseResult(await handler({ month: "2024-06-01" }));
      expect(result.underfunded_targets.count).toBe(0);
      expect(result.underfunded_targets.total).toBe(0);
    });

    it("caps top_underfunded at 10 items", async () => {
      const cats = Array.from({ length: 15 }, (_, i) => ({
        id: `cat-${i}`,
        name: `Category ${i}`,
        goal_type: "MF",
        goal_under_funded: (i + 1) * 10000,
      }));
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Monthly", cats),
      ]);

      const result = parseResult(await handler({ month: "2024-06-01" }));
      expect(result.underfunded_targets.count).toBe(15);
      expect(result.underfunded_targets.top_underfunded).toHaveLength(10);
    });
  });

  describe("credit card gaps", () => {
    it("computes gap when owed exceeds payment available", async () => {
      ctx.ynabClient.getAccounts.mockResolvedValue([
        {
          id: "cc-1",
          name: "Amex Gold",
          type: "creditCard",
          balance: -500000, // owes $500
          closed: false,
        },
      ]);
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup(
          "Credit Card Payments",
          [{ id: "cc-cat-1", name: "Amex Gold", balance: 350000 }], // $350 available
          "cc-group",
        ),
      ]);

      const result = parseResult(await handler({ month: "2024-06-01" }));

      expect(result.credit_card_gaps).toHaveLength(1);
      expect(result.credit_card_gaps[0].account_name).toBe("Amex Gold");
      expect(result.credit_card_gaps[0].account_balance).toBe(-500);
      expect(result.credit_card_gaps[0].payment_available).toBe(350);
      expect(result.credit_card_gaps[0].gap).toBe(150);
    });

    it("reports no gap when payment category fully covers owed balance", async () => {
      ctx.ynabClient.getAccounts.mockResolvedValue([
        {
          id: "cc-1",
          name: "Chase Sapphire",
          type: "creditCard",
          balance: -200000,
          closed: false,
        },
      ]);
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup(
          "Credit Card Payments",
          [{ id: "cc-cat-1", name: "Chase Sapphire", balance: 250000 }],
          "cc-group",
        ),
      ]);

      const result = parseResult(await handler({ month: "2024-06-01" }));
      expect(result.credit_card_gaps).toHaveLength(0);
    });

    it("skips credit card accounts that have no matching payment category", async () => {
      ctx.ynabClient.getAccounts.mockResolvedValue([
        {
          id: "cc-1",
          name: "Orphan Card",
          type: "creditCard",
          balance: -100000,
          closed: false,
        },
      ]);
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup(
          "Credit Card Payments",
          [{ id: "cc-cat-1", name: "Different Card", balance: 50000 }],
          "cc-group",
        ),
      ]);

      const result = parseResult(await handler({ month: "2024-06-01" }));
      expect(result.credit_card_gaps).toHaveLength(0);
    });
  });

  describe("uncategorized and unapproved counts", () => {
    it("counts uncategorized and unapproved transactions", async () => {
      // First call is for uncategorized, second is for unapproved
      ctx.ynabClient.searchTransactions
        .mockResolvedValueOnce([{ id: "t1" }, { id: "t2" }, { id: "t3" }])
        .mockResolvedValueOnce([{ id: "t4" }]);

      const result = parseResult(await handler({ month: "2024-06-01" }));
      expect(result.uncategorized_count).toBe(3);
      expect(result.unapproved_count).toBe(1);
    });
  });

  describe("issues generation", () => {
    it("generates critical issue for negative RTA", async () => {
      ctx.ynabClient.getMonthSummary.mockResolvedValue({
        to_be_budgeted: -100000,
        age_of_money: null,
      });

      const result = parseResult(await handler({ month: "2024-06-01" }));
      const critical = result.issues.filter(
        (i: Record<string, unknown>) => i.severity === "critical",
      );
      expect(critical).toHaveLength(1);
      expect(critical[0].message).toContain("Ready to Assign is negative");
      expect(critical[0].message).toContain("-$100.00");
    });

    it("generates critical issue for cash overspending", async () => {
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Everyday", [
          { id: "cat-1", name: "Groceries", balance: -60000 },
        ]),
      ]);

      const result = parseResult(await handler({ month: "2024-06-01" }));
      const critical = result.issues.filter(
        (i: Record<string, unknown>) => i.severity === "critical",
      );
      expect(critical.length).toBeGreaterThanOrEqual(1);
      expect(
        critical.some((i: Record<string, string>) =>
          i.message.includes("Cash overspending"),
        ),
      ).toBe(true);
    });

    it("generates warning for credit card gaps", async () => {
      ctx.ynabClient.getAccounts.mockResolvedValue([
        {
          id: "cc-1",
          name: "Visa",
          type: "creditCard",
          balance: -300000,
          closed: false,
        },
      ]);
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup(
          "Credit Card Payments",
          [{ id: "cc-cat-1", name: "Visa", balance: 100000 }],
          "cc-group",
        ),
      ]);

      const result = parseResult(await handler({ month: "2024-06-01" }));
      const warnings = result.issues.filter(
        (i: Record<string, unknown>) => i.severity === "warning",
      );
      expect(
        warnings.some((i: Record<string, string>) =>
          i.message.includes("payment gap"),
        ),
      ).toBe(true);
    });

    it("generates warning for underfunded targets", async () => {
      ctx.ynabClient.getCategories.mockResolvedValue([
        makeGroup("Bills", [
          {
            id: "cat-1",
            name: "Rent",
            goal_type: "NEED",
            goal_under_funded: 100000,
          },
        ]),
      ]);

      const result = parseResult(await handler({ month: "2024-06-01" }));
      const warnings = result.issues.filter(
        (i: Record<string, unknown>) => i.severity === "warning",
      );
      expect(
        warnings.some((i: Record<string, string>) =>
          i.message.includes("underfunded"),
        ),
      ).toBe(true);
    });

    it("generates warning for uncategorized transactions", async () => {
      ctx.ynabClient.searchTransactions
        .mockResolvedValueOnce([{ id: "t1" }, { id: "t2" }])
        .mockResolvedValueOnce([]);

      const result = parseResult(await handler({ month: "2024-06-01" }));
      const warnings = result.issues.filter(
        (i: Record<string, unknown>) => i.severity === "warning",
      );
      expect(
        warnings.some((i: Record<string, string>) =>
          i.message.includes("2 uncategorized"),
        ),
      ).toBe(true);
    });

    it("generates info issue for unapproved transactions", async () => {
      ctx.ynabClient.searchTransactions
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "t1" }]);

      const result = parseResult(await handler({ month: "2024-06-01" }));
      const infos = result.issues.filter(
        (i: Record<string, unknown>) => i.severity === "info",
      );
      expect(
        infos.some((i: Record<string, string>) =>
          i.message.includes("1 unapproved"),
        ),
      ).toBe(true);
    });

    it("generates info issue for positive RTA suggesting allocation", async () => {
      ctx.ynabClient.getMonthSummary.mockResolvedValue({
        to_be_budgeted: 250000,
        age_of_money: 60,
      });

      const result = parseResult(await handler({ month: "2024-06-01" }));
      const infos = result.issues.filter(
        (i: Record<string, unknown>) => i.severity === "info",
      );
      expect(
        infos.some((i: Record<string, string>) =>
          i.message.includes("Ready to Assign"),
        ),
      ).toBe(true);
    });

    it("generates healthy message when no issues found", async () => {
      const result = parseResult(await handler({ month: "2024-06-01" }));
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].severity).toBe("info");
      expect(result.issues[0].message).toContain("healthy");
    });
  });

  describe("empty budget", () => {
    it("handles no categories, no accounts gracefully", async () => {
      ctx.ynabClient.getCategories.mockResolvedValue([]);
      ctx.ynabClient.getAccounts.mockResolvedValue([]);
      ctx.ynabClient.getMonthSummary.mockResolvedValue({
        to_be_budgeted: 0,
        age_of_money: null,
      });

      const result = parseResult(await handler({ month: "2024-06-01" }));

      expect(result.overspending.categories).toHaveLength(0);
      expect(result.overspending.total_cash).toBe(0);
      expect(result.overspending.total_credit).toBe(0);
      expect(result.underfunded_targets.count).toBe(0);
      expect(result.credit_card_gaps).toHaveLength(0);
      expect(result.uncategorized_count).toBe(0);
      expect(result.unapproved_count).toBe(0);
      expect(result.age_of_money).toBeNull();
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].message).toContain("healthy");
    });
  });

  describe("age_of_money", () => {
    it("passes through age_of_money from month summary", async () => {
      ctx.ynabClient.getMonthSummary.mockResolvedValue({
        to_be_budgeted: 0,
        age_of_money: 72,
      });

      const result = parseResult(await handler({ month: "2024-06-01" }));
      expect(result.age_of_money).toBe(72);
    });
  });
});
