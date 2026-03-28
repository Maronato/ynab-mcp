import { beforeEach, describe, expect, it } from "vitest";
import type { MockAppContext } from "../test-utils.js";
import {
  captureToolHandlers,
  createMockContext,
  createMockCurrencyFormat,
} from "../test-utils.js";
import { registerCreditDiagnosisTools } from "./credit-diagnosis.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

let ctx: MockAppContext;
let handler: ToolHandler;

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function setupDefaults() {
  ctx.ynabClient.getBudgetSettings.mockResolvedValue({
    currency_format: createMockCurrencyFormat(),
  });
  ctx.ynabClient.getMonthSummary.mockResolvedValue({ categories: [] });
}

function makeCreditCardAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: "acc-visa",
    name: "Visa Platinum",
    type: "creditCard",
    balance: -500000, // owes $500
    closed: false,
    ...overrides,
  };
}

function makeCategoryGroups(
  paymentCategories: Array<{
    id: string;
    name: string;
    balance: number;
  }> = [],
) {
  return [
    {
      id: "group-cc",
      name: "Credit Card Payments",
      hidden: false,
      deleted: false,
      categories: paymentCategories.map((cat) => ({
        ...cat,
        hidden: false,
        deleted: false,
        budgeted: 0,
        activity: 0,
        category_group_id: "group-cc",
        goal_type: null,
        goal_target: null,
        goal_target_date: null,
        goal_percentage_complete: null,
      })),
    },
    {
      id: "group-bills",
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
          category_group_id: "group-bills",
          goal_type: null,
          goal_target: null,
          goal_target_date: null,
          goal_percentage_complete: null,
        },
        {
          id: "cat-internet",
          name: "Internet",
          hidden: false,
          deleted: false,
          budgeted: 80000,
          activity: -120000,
          balance: -40000,
          category_group_id: "group-bills",
          goal_type: null,
          goal_target: null,
          goal_target_date: null,
          goal_percentage_complete: null,
        },
      ],
    },
    {
      id: "group-everyday",
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
          category_group_id: "group-everyday",
          goal_type: null,
          goal_target: null,
          goal_target_date: null,
          goal_percentage_complete: null,
        },
      ],
    },
  ];
}

beforeEach(() => {
  ctx = createMockContext();
  const tools = captureToolHandlers(registerCreditDiagnosisTools, ctx);
  handler = tools.diagnose_credit_card_debt;
  setupDefaults();
});

describe("diagnose_credit_card_debt", () => {
  describe("basic gap computation", () => {
    it("computes the correct gap between card balance and payment available", async () => {
      const visa = makeCreditCardAccount({
        id: "acc-visa",
        name: "Visa Platinum",
        balance: -500000, // owes $500
      });

      ctx.ynabClient.getAccounts.mockResolvedValue([visa]);
      ctx.ynabClient.getCategories.mockResolvedValue(
        makeCategoryGroups([
          {
            id: "cat-visa-pay",
            name: "Visa Platinum",
            balance: 300000, // $300 available
          },
        ]),
      );

      const result = parseResult(await handler({}));

      expect(result.cards).toHaveLength(1);
      const card = result.cards[0];
      expect(card.account_name).toBe("Visa Platinum");
      expect(card.card_balance).toBeCloseTo(-500, 0);
      expect(card.payment_available).toBeCloseTo(300, 0);
      // gap = |500| - 300 = 200
      expect(card.gap).toBeCloseTo(200, 0);
      expect(card.has_debt).toBe(true);
    });

    it("reports zero gap when payment available covers the balance", async () => {
      const visa = makeCreditCardAccount({
        balance: -200000, // owes $200
      });

      ctx.ynabClient.getAccounts.mockResolvedValue([visa]);
      ctx.ynabClient.getCategories.mockResolvedValue(
        makeCategoryGroups([
          {
            id: "cat-visa-pay",
            name: "Visa Platinum",
            balance: 250000, // $250 available - more than enough
          },
        ]),
      );

      const result = parseResult(await handler({}));

      const card = result.cards[0];
      expect(card.gap).toBe(0);
      expect(card.has_debt).toBe(false);
    });

    it("handles a card with zero balance (no debt)", async () => {
      const visa = makeCreditCardAccount({
        balance: 0,
      });

      ctx.ynabClient.getAccounts.mockResolvedValue([visa]);
      ctx.ynabClient.getCategories.mockResolvedValue(
        makeCategoryGroups([
          {
            id: "cat-visa-pay",
            name: "Visa Platinum",
            balance: 0,
          },
        ]),
      );

      const result = parseResult(await handler({}));

      const card = result.cards[0];
      expect(card.gap).toBe(0);
      expect(card.has_debt).toBe(false);
      expect(card.debt_sources).toHaveLength(0);
    });
  });

  describe("multiple credit cards", () => {
    it("diagnoses each card independently", async () => {
      const visa = makeCreditCardAccount({
        id: "acc-visa",
        name: "Visa Platinum",
        balance: -500000,
      });
      const amex = makeCreditCardAccount({
        id: "acc-amex",
        name: "Amex Gold",
        balance: -300000,
      });

      ctx.ynabClient.getAccounts.mockResolvedValue([visa, amex]);
      ctx.ynabClient.getCategories.mockResolvedValue(
        makeCategoryGroups([
          { id: "cat-visa-pay", name: "Visa Platinum", balance: 500000 },
          { id: "cat-amex-pay", name: "Amex Gold", balance: 100000 },
        ]),
      );

      const result = parseResult(await handler({}));

      expect(result.cards).toHaveLength(2);

      const visaCard = result.cards.find(
        (c: { account_name: string }) => c.account_name === "Visa Platinum",
      );
      expect(visaCard.has_debt).toBe(false);
      expect(visaCard.gap).toBe(0);

      const amexCard = result.cards.find(
        (c: { account_name: string }) => c.account_name === "Amex Gold",
      );
      expect(amexCard.has_debt).toBe(true);
      // gap = |300| - 100 = 200
      expect(amexCard.gap).toBeCloseTo(200, 0);
    });

    it("computes total_debt across all cards", async () => {
      const visa = makeCreditCardAccount({
        id: "acc-visa",
        name: "Visa Platinum",
        balance: -500000,
      });
      const amex = makeCreditCardAccount({
        id: "acc-amex",
        name: "Amex Gold",
        balance: -300000,
      });

      ctx.ynabClient.getAccounts.mockResolvedValue([visa, amex]);
      ctx.ynabClient.getCategories.mockResolvedValue(
        makeCategoryGroups([
          { id: "cat-visa-pay", name: "Visa Platinum", balance: 400000 },
          { id: "cat-amex-pay", name: "Amex Gold", balance: 100000 },
        ]),
      );

      const result = parseResult(await handler({}));

      // Visa gap = 500-400 = 100, Amex gap = 300-100 = 200, total = 300
      expect(result.total_debt).toBeCloseTo(300, 0);
    });
  });

  describe("debt sources", () => {
    it("identifies overspent categories as debt sources", async () => {
      const visa = makeCreditCardAccount({
        balance: -500000,
      });

      ctx.ynabClient.getAccounts.mockResolvedValue([visa]);
      ctx.ynabClient.getCategories.mockResolvedValue(
        makeCategoryGroups([
          {
            id: "cat-visa-pay",
            name: "Visa Platinum",
            balance: 300000,
          },
        ]),
      );

      // Return month details with overspent categories
      ctx.ynabClient.getMonthSummary.mockResolvedValue({
        categories: [
          {
            id: "cat-electric",
            name: "Electric",
            balance: -50000,
            hidden: false,
            deleted: false,
          },
          {
            id: "cat-internet",
            name: "Internet",
            balance: -40000,
            hidden: false,
            deleted: false,
          },
          {
            id: "cat-groceries",
            name: "Groceries",
            balance: 200000,
            hidden: false,
            deleted: false,
          },
        ],
      });

      const result = parseResult(await handler({ lookback_months: 3 }));

      const card = result.cards[0];
      expect(card.has_debt).toBe(true);
      expect(card.debt_sources.length).toBeGreaterThanOrEqual(1);

      // Should include Electric ($50 overspent) and Internet ($40 overspent)
      const sourceNames = card.debt_sources.map(
        (s: { category_name: string }) => s.category_name,
      );
      expect(sourceNames).toContain("Electric");
      expect(sourceNames).toContain("Internet");

      // Should NOT include Groceries (positive balance)
      expect(sourceNames).not.toContain("Groceries");
    });

    it("sorts debt sources by overspent amount descending", async () => {
      const visa = makeCreditCardAccount({ balance: -500000 });

      ctx.ynabClient.getAccounts.mockResolvedValue([visa]);
      ctx.ynabClient.getCategories.mockResolvedValue(
        makeCategoryGroups([
          { id: "cat-visa-pay", name: "Visa Platinum", balance: 300000 },
        ]),
      );

      ctx.ynabClient.getMonthSummary.mockResolvedValue({
        categories: [
          {
            id: "cat-internet",
            name: "Internet",
            balance: -40000,
            hidden: false,
            deleted: false,
          },
          {
            id: "cat-electric",
            name: "Electric",
            balance: -80000,
            hidden: false,
            deleted: false,
          },
        ],
      });

      const result = parseResult(await handler({ lookback_months: 1 }));

      const sources = result.cards[0].debt_sources;
      expect(sources[0].category_name).toBe("Electric");
      expect(sources[0].overspent_amount).toBeGreaterThan(
        sources[1].overspent_amount,
      );
    });

    it("skips payment categories themselves from debt sources", async () => {
      const visa = makeCreditCardAccount({ balance: -500000 });

      ctx.ynabClient.getAccounts.mockResolvedValue([visa]);
      ctx.ynabClient.getCategories.mockResolvedValue(
        makeCategoryGroups([
          {
            id: "cat-visa-pay",
            name: "Visa Platinum",
            balance: 300000,
          },
        ]),
      );

      // Simulate the payment category itself having a negative balance
      ctx.ynabClient.getMonthSummary.mockResolvedValue({
        categories: [
          {
            id: "cat-visa-pay",
            name: "Visa Platinum",
            balance: -100000,
            hidden: false,
            deleted: false,
          },
          {
            id: "cat-electric",
            name: "Electric",
            balance: -50000,
            hidden: false,
            deleted: false,
          },
        ],
      });

      const result = parseResult(await handler({ lookback_months: 1 }));

      const sourceNames = result.cards[0].debt_sources.map(
        (s: { category_name: string }) => s.category_name,
      );
      expect(sourceNames).not.toContain("Visa Platinum");
      expect(sourceNames).toContain("Electric");
    });

    it("does not scan for debt sources when there is no gap", async () => {
      const visa = makeCreditCardAccount({ balance: -200000 });

      ctx.ynabClient.getAccounts.mockResolvedValue([visa]);
      ctx.ynabClient.getCategories.mockResolvedValue(
        makeCategoryGroups([
          { id: "cat-visa-pay", name: "Visa Platinum", balance: 300000 },
        ]),
      );

      const result = parseResult(await handler({ lookback_months: 3 }));

      const card = result.cards[0];
      expect(card.has_debt).toBe(false);
      expect(card.debt_sources).toHaveLength(0);
      // getMonthSummary should not have been called for debt source scanning
      // (it may still be called 0 times since no debt)
    });

    it("excludes hidden and deleted categories from debt sources", async () => {
      const visa = makeCreditCardAccount({ balance: -500000 });

      ctx.ynabClient.getAccounts.mockResolvedValue([visa]);
      ctx.ynabClient.getCategories.mockResolvedValue(
        makeCategoryGroups([
          { id: "cat-visa-pay", name: "Visa Platinum", balance: 200000 },
        ]),
      );

      ctx.ynabClient.getMonthSummary.mockResolvedValue({
        categories: [
          {
            id: "cat-hidden",
            name: "Old Category",
            balance: -100000,
            hidden: true,
            deleted: false,
          },
          {
            id: "cat-deleted",
            name: "Deleted Category",
            balance: -80000,
            hidden: false,
            deleted: true,
          },
          {
            id: "cat-electric",
            name: "Electric",
            balance: -50000,
            hidden: false,
            deleted: false,
          },
        ],
      });

      const result = parseResult(await handler({ lookback_months: 1 }));

      const sourceNames = result.cards[0].debt_sources.map(
        (s: { category_name: string }) => s.category_name,
      );
      expect(sourceNames).not.toContain("Old Category");
      expect(sourceNames).not.toContain("Deleted Category");
      expect(sourceNames).toContain("Electric");
    });
  });

  describe("set_budget_actions", () => {
    it("generates actions with correct gap amount for each card with debt", async () => {
      const visa = makeCreditCardAccount({
        id: "acc-visa",
        name: "Visa Platinum",
        balance: -500000,
      });

      ctx.ynabClient.getAccounts.mockResolvedValue([visa]);
      ctx.ynabClient.getCategories.mockResolvedValue(
        makeCategoryGroups([
          { id: "cat-visa-pay", name: "Visa Platinum", balance: 300000 },
        ]),
      );

      const result = parseResult(await handler({ lookback_months: 1 }));

      expect(result.set_budget_actions).toHaveLength(1);
      const action = result.set_budget_actions[0];
      expect(action.category_id).toBe("cat-visa-pay");
      // budgeted should be the gap amount in currency: 200
      expect(action.budgeted).toBeCloseTo(200, 0);
      expect(action.month).toBeDefined();
    });

    it("does not generate actions for cards with no debt", async () => {
      const visa = makeCreditCardAccount({ balance: -200000 });

      ctx.ynabClient.getAccounts.mockResolvedValue([visa]);
      ctx.ynabClient.getCategories.mockResolvedValue(
        makeCategoryGroups([
          { id: "cat-visa-pay", name: "Visa Platinum", balance: 300000 },
        ]),
      );

      const result = parseResult(await handler({}));

      expect(result.set_budget_actions).toHaveLength(0);
    });
  });

  describe("no credit cards", () => {
    it("returns a message when no credit card accounts exist", async () => {
      ctx.ynabClient.getAccounts.mockResolvedValue([
        {
          id: "acc-checking",
          name: "Checking",
          type: "checking",
          balance: 1000000,
          closed: false,
        },
      ]);
      ctx.ynabClient.getCategories.mockResolvedValue(makeCategoryGroups());

      const result = parseResult(await handler({}));

      expect(result.cards).toHaveLength(0);
      expect(result.total_debt).toBe(0);
      expect(result.set_budget_actions).toHaveLength(0);
      expect(result.message).toContain("No credit card");
    });
  });

  describe("missing payment category", () => {
    it("handles a card with no matching payment category (treats available as 0)", async () => {
      const visa = makeCreditCardAccount({
        name: "Chase Freedom",
        balance: -400000,
      });

      ctx.ynabClient.getAccounts.mockResolvedValue([visa]);
      // No payment categories match "Chase Freedom"
      ctx.ynabClient.getCategories.mockResolvedValue(
        makeCategoryGroups([
          { id: "cat-visa-pay", name: "Visa Platinum", balance: 300000 },
        ]),
      );

      const result = parseResult(await handler({}));

      const card = result.cards[0];
      expect(card.account_name).toBe("Chase Freedom");
      // payment_available should be 0 since no matching category
      expect(card.payment_available).toBe(0);
      // gap = |400| - 0 = 400
      expect(card.gap).toBeCloseTo(400, 0);
      expect(card.has_debt).toBe(true);
    });
  });

  describe("budget_id", () => {
    it("returns the resolved budget_id in the result", async () => {
      ctx.ynabClient.getAccounts.mockResolvedValue([]);
      ctx.ynabClient.getCategories.mockResolvedValue(makeCategoryGroups());

      const result = parseResult(await handler({ budget_id: "my-budget" }));

      expect(result.budget_id).toBe("my-budget");
    });
  });
});
