import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeBudgetBuilder } from "./fake-ynab/builder.js";
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./harness.js";
import {
  CURRENT_MONTH,
  dateStr,
  endOfMonth,
  LAST_MONTH,
  seedStandardBudget,
  TWO_MONTHS_AGO,
} from "./seed.js";

/** Number of days in the month of a YYYY-MM-DD string. Parses components to avoid timezone shifts. */
function daysIn(dateStr: string): number {
  const [y, m] = dateStr.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

/**
 * Extended seed that adds data needed by analytics tools beyond the standard seed:
 * - Multiple months of month details for trends/income-expense/velocity/forecast
 * - Recurring payee transactions for detect_recurring_charges
 * - Extra grocery transactions for detect_anomalies (need >= 5 for unusual_amount)
 * - An anomaly outlier transaction for detect_anomalies
 * - Credit card payment category for credit card diagnosis
 * - Overspent and underfunded categories for health/rebalance tools
 * - An uncategorized transaction for suggest_transaction_categories
 */
function seedAnalyticsBudget(builder: FakeBudgetBuilder): void {
  // Start with the standard seed
  seedStandardBudget(builder);

  // Add a Credit Card Payments category group matching acct-credit name
  builder.withCategoryGroup("cg-cc-payments", "Credit Card Payments", [
    {
      id: "cat-cc-credit",
      name: "Credit Card",
      budgeted: 500000,
      activity: 0,
      balance: 500000,
    },
  ]);

  // Month detail for TWO_MONTHS_AGO
  builder
    .withMonthCategory(TWO_MONTHS_AGO, "cat-groceries", {
      budgeted: 400000,
      activity: -350000,
    })
    .withMonthCategory(TWO_MONTHS_AGO, "cat-dining", {
      budgeted: 200000,
      activity: -180000,
    })
    .withMonthCategory(TWO_MONTHS_AGO, "cat-transport", {
      budgeted: 150000,
      activity: -100000,
    })
    .withMonthCategory(TWO_MONTHS_AGO, "cat-rent", {
      budgeted: 1500000,
      activity: -1500000,
    })
    .withMonthCategory(TWO_MONTHS_AGO, "cat-utilities", {
      budgeted: 150000,
      activity: -110000,
    })
    .withMonthCategory(TWO_MONTHS_AGO, "cat-internet", {
      budgeted: 60000,
      activity: -55000,
    })
    .withMonth(TWO_MONTHS_AGO, {
      income: 6000000,
      budgeted: 2460000,
      activity: -2295000,
      to_be_budgeted: 3540000,
      age_of_money: 40,
    });

  // Month detail for LAST_MONTH
  builder
    .withMonthCategory(LAST_MONTH, "cat-groceries", {
      budgeted: 400000,
      activity: -380000,
    })
    .withMonthCategory(LAST_MONTH, "cat-dining", {
      budgeted: 200000,
      activity: -150000,
    })
    .withMonthCategory(LAST_MONTH, "cat-transport", {
      budgeted: 150000,
      activity: -120000,
    })
    .withMonthCategory(LAST_MONTH, "cat-rent", {
      budgeted: 1500000,
      activity: -1500000,
    })
    .withMonthCategory(LAST_MONTH, "cat-utilities", {
      budgeted: 150000,
      activity: -95000,
    })
    .withMonthCategory(LAST_MONTH, "cat-internet", {
      budgeted: 60000,
      activity: -55000,
    })
    .withMonth(LAST_MONTH, {
      income: 6000000,
      budgeted: 2460000,
      activity: -2300000,
      to_be_budgeted: 3540000,
      age_of_money: 42,
    });

  // Add recurring payee transactions (landlord already has 3, add more
  // for internet provider to build recurring detection)
  builder
    .withTransaction("tx-recurring-internet-2", {
      account_id: "acct-checking",
      amount: -55000,
      date: dateStr(1, 15),
      payee_id: "payee-internet",
      category_id: "cat-internet",
      cleared: "cleared",
    })
    .withTransaction("tx-recurring-internet-3", {
      account_id: "acct-checking",
      amount: -55000,
      date: dateStr(0, 15),
      payee_id: "payee-internet",
      category_id: "cat-internet",
      cleared: "cleared",
    });

  // Add extra grocery transactions so payee history has >= 5 entries
  // (required for "unusual_amount" anomaly detection).
  // Standard seed already has tx-2 (2 months ago) and tx-7 (1 month ago).
  builder
    .withTransaction("tx-grocery-extra-1", {
      account_id: "acct-checking",
      amount: -90000,
      date: dateStr(2, 20),
      payee_id: "payee-grocery",
      category_id: "cat-groceries",
      cleared: "cleared",
    })
    .withTransaction("tx-grocery-extra-2", {
      account_id: "acct-checking",
      amount: -80000,
      date: dateStr(1, 18),
      payee_id: "payee-grocery",
      category_id: "cat-groceries",
      cleared: "cleared",
    })
    .withTransaction("tx-grocery-extra-3", {
      account_id: "acct-checking",
      amount: -70000,
      date: dateStr(0, 3),
      payee_id: "payee-grocery",
      category_id: "cat-groceries",
      cleared: "cleared",
    });

  // Add an anomaly: an outlier grocery transaction (10x normal)
  builder.withTransaction("tx-anomaly", {
    account_id: "acct-checking",
    amount: -850000,
    date: dateStr(0, 5),
    payee_id: "payee-grocery",
    category_id: "cat-groceries",
    cleared: "cleared",
    memo: "Suspicious large charge",
  });

  // Add an uncategorized+unapproved transaction for suggest_transaction_categories
  builder
    .withPayee("payee-new-store", "New Store")
    .withTransaction("tx-uncategorized", {
      account_id: "acct-checking",
      amount: -25000,
      date: dateStr(0, 10),
      payee_id: "payee-grocery",
      category_id: null,
      cleared: "uncleared",
      approved: false,
    });

  builder.build();
}

let harness: IntegrationHarness;

beforeEach(async () => {
  harness = await createIntegrationHarness({ seed: seedAnalyticsBudget });
});

afterEach(async () => {
  await harness.close();
});

// ── get_budget_summary ──

describe("get_budget_summary", () => {
  it("returns net worth, account summary, and month totals", async () => {
    const result = (await harness.callTool("get_budget_summary", {})) as {
      net_worth_milliunits: number;
      net_worth_display: string;
      account_summary_by_type: Array<{
        type: string;
        total_balance_milliunits: number;
        count: number;
      }>;
    };

    // Seed accounts: checking 5,000,000 + credit -1,000,000 + savings 10,000,000 = 14,000,000
    expect(result.net_worth_milliunits).toBe(14000000);
    expect(result.net_worth_display).toBeTruthy();
    // 3 account types: checking, creditCard, savings
    expect(result.account_summary_by_type.length).toBe(3);
  });
});

// ── sync_budget_data ──

describe("sync_budget_data", () => {
  it("syncs successfully and returns change counts", async () => {
    const result = (await harness.callTool("sync_budget_data", {})) as {
      budget_id: string;
      message: string;
      changes: Record<string, unknown>;
    };

    expect(result.message).toContain("synced");
    expect(result.budget_id).toBeTruthy();
  });
});

// ── get_targets ──

describe("get_targets", () => {
  it("returns categories with target fields", async () => {
    const result = (await harness.callTool("get_targets", {
      month: CURRENT_MONTH,
    })) as {
      groups: Array<{
        id: string;
        name: string;
        categories: Array<{
          id: string;
          name: string;
          target_type: string | null;
        }>;
      }>;
    };

    expect(result.groups.length).toBeGreaterThan(0);
    const allCats = result.groups.flatMap((g) => g.categories);
    expect(allCats.length).toBeGreaterThan(0);
    // Every category should have target_type field (null if no target)
    for (const cat of allCats) {
      expect(cat).toHaveProperty("target_type");
    }
  });
});

// ── get_spending_analysis ──

describe("get_spending_analysis", () => {
  it("aggregates spending by category for a date range", async () => {
    const result = (await harness.callTool("get_spending_analysis", {
      since_date: TWO_MONTHS_AGO,
      until_date: endOfMonth(CURRENT_MONTH),
      group_by: "category",
    })) as {
      total_spending: number;
      transaction_count: number;
      by_category: Array<{
        id: string;
        name: string;
        total: number;
        count: number;
      }>;
    };

    // All seed outflow transactions:
    // standard 10 + 2 recurring internet + 3 extra grocery + anomaly + uncategorized = 17
    expect(result.transaction_count).toBe(17);
    expect(result.total_spending).toBeGreaterThan(0);
    // Categories present: Rent/Mortgage, Groceries, Dining Out, Transportation,
    // Internet, Utilities, and Uncategorized
    expect(result.by_category.length).toBe(7);
    // Rent is the biggest: 3x $15.00 = $45.00
    expect(result.by_category[0].name).toBe("Rent/Mortgage");
    expect(result.by_category[0].count).toBe(3);
  });

  it("aggregates spending by payee", async () => {
    const result = (await harness.callTool("get_spending_analysis", {
      since_date: TWO_MONTHS_AGO,
      group_by: "payee",
    })) as {
      by_payee: Array<{ id: string; name: string; total: number }>;
    };

    // Payees with outflows: Landlord, Grocery Store, Italian Restaurant,
    // Gas Station, Internet Provider, Electric Company
    expect(result.by_payee.length).toBe(6);
    // Landlord is the highest spender (3x $15.00)
    expect(result.by_payee[0].name).toBe("Landlord");
  });
});

// ── suggest_transaction_categories ──

describe("suggest_transaction_categories", () => {
  it("finds uncategorized transactions and suggests categories", async () => {
    const result = (await harness.callTool("suggest_transaction_categories", {
      since_date: TWO_MONTHS_AGO,
    })) as {
      budget_id: string;
      suggestion_count: number;
      suggestions: Array<{
        transaction_id: string;
        payee_name: string;
        confidence: string;
      }>;
      update_actions: Array<{
        transaction_id: string;
        category_id: string;
      }>;
    };

    expect(result.budget_id).toBeTruthy();
    // The seed has exactly one uncategorized transaction (tx-uncategorized)
    // with payee_id "payee-grocery" (Grocery Store). The tool should detect it
    // and suggest a category based on the payee's history (cat-groceries).
    expect(result.suggestion_count).toBeGreaterThanOrEqual(1);
    // The uncategorized tx has payee "Grocery Store" — check the suggestion references it
    const grocerySuggestion = result.suggestions.find(
      (s) => s.transaction_id === "tx-uncategorized",
    );
    expect(grocerySuggestion).toBeDefined();
    expect(grocerySuggestion?.payee_name).toBe("Grocery Store");
  });
});

// ── suggest_overspending_coverage ──

describe("suggest_overspending_coverage", () => {
  it("analyzes overspending and returns suggestions", async () => {
    const result = (await harness.callTool("suggest_overspending_coverage", {
      month: CURRENT_MONTH,
    })) as {
      budget_id: string;
      month: string;
      suggestion_count?: number;
      suggestions?: Array<{
        from_category_id: string;
        to_category_id: string;
        amount: number;
      }>;
      set_budget_actions?: Array<{
        category_id: string;
        month: string;
        budgeted: number;
      }>;
      overspent_count?: number;
      message?: string;
    };

    expect(result.budget_id).toBeTruthy();
    expect(result.month).toBe(CURRENT_MONTH);
    // May have no overspent categories or some, depending on seed balance
    expect(
      typeof result.suggestion_count === "number" ||
        typeof result.overspent_count === "number" ||
        typeof result.message === "string",
    ).toBe(true);
  });
});

// ── set_category_targets ──

describe("set_category_targets", () => {
  it("sets a target on a category and returns before/after state", async () => {
    const result = (await harness.callTool("set_category_targets", {
      targets: [
        {
          category_id: "cat-emergency",
          goal_target: 10000.0,
          goal_target_date: "2025-12-01",
        },
      ],
    })) as {
      budget_id: string;
      results: Array<{
        category_id: string;
        status: string;
        before?: { goal_target: number | null };
        after?: { goal_target: number | null };
      }>;
      undo_history_ids: string[];
    };

    expect(result.results.length).toBe(1);
    expect(result.results[0].status).toBe("updated");
    expect(result.results[0].after?.goal_target).toBe(10000.0);
    expect(result.undo_history_ids.length).toBeGreaterThan(0);
  });
});

// ── get_budget_health ──

describe("get_budget_health", () => {
  it("returns health diagnostics for a month", async () => {
    const result = (await harness.callTool("get_budget_health", {
      month: CURRENT_MONTH,
    })) as {
      budget_id: string;
      month: string;
      ready_to_assign: { amount: number; status: string };
      overspending: {
        total_cash: number;
        categories: Array<{ id: string; name: string }>;
      };
      underfunded_targets: { count: number };
      credit_card_gaps: Array<{
        account_id: string;
        gap: number;
      }>;
      uncategorized_count: number;
      unapproved_count: number;
      issues: Array<{ severity: string; message: string }>;
    };

    expect(result.budget_id).toBeTruthy();
    expect(result.month).toBe(CURRENT_MONTH);
    // Seed month to_be_budgeted = 2,840,000 milliunits → positive
    expect(result.ready_to_assign.status).toBe("positive");
    expect(result.ready_to_assign.amount).toBeGreaterThan(0);
    expect(result.overspending).toHaveProperty("total_cash");
    // Seed has exactly one uncategorized tx (tx-uncategorized) in the current month
    expect(result.uncategorized_count).toBe(1);
    // Seed has exactly one unapproved tx (tx-uncategorized, approved: false) in the current month
    expect(result.unapproved_count).toBe(1);
    // Issues should always contain at least the RTA positive info message
    expect(result.issues.length).toBeGreaterThanOrEqual(1);
    const severities = result.issues.map((i) => i.severity);
    expect(severities).toContain("info");
  });
});

// ── get_spending_velocity ──

describe("get_spending_velocity", () => {
  it("returns velocity analysis with risk levels", async () => {
    const result = (await harness.callTool("get_spending_velocity", {
      month: CURRENT_MONTH,
      history_months: 2,
    })) as {
      budget_id: string;
      month: string;
      day_of_month: number;
      days_in_month: number;
      overall_status: string;
      categories: Array<{
        id: string;
        name: string;
        budgeted: number;
        risk: string;
        daily_burn_rate: number;
      }>;
    };

    expect(result.budget_id).toBeTruthy();
    expect(result.month).toBe(CURRENT_MONTH);
    expect(result.days_in_month).toBe(daysIn(CURRENT_MONTH));
    // Should analyze budgeted categories from seed (6 non-savings categories)
    expect(result.categories.length).toBeGreaterThan(0);
    for (const cat of result.categories) {
      expect(["likely_overspend", "watch", "safe"]).toContain(cat.risk);
      expect(cat.daily_burn_rate).toBeGreaterThanOrEqual(0);
      expect(cat.budgeted).toBeGreaterThanOrEqual(0);
    }
    // Verify known category IDs from seed are present
    const catIds = result.categories.map((c) => c.id);
    expect(catIds).toContain("cat-groceries");
    expect(catIds).toContain("cat-rent");
  });
});

// ── suggest_budget_allocation ──

describe("suggest_budget_allocation", () => {
  it("suggests allocations for a given amount", async () => {
    const result = (await harness.callTool("suggest_budget_allocation", {
      month: CURRENT_MONTH,
      available_amount: 1000.0,
      history_months: 2,
    })) as {
      budget_id: string;
      month: string;
      available_amount: number;
      total_allocated: number;
      allocation_count: number;
      allocations: Array<{
        category_id: string;
        category_name: string;
        priority: string;
        amount: number;
        reason: string;
      }>;
      set_budget_actions: Array<{
        category_id: string;
        month: string;
        budgeted: number;
      }>;
    };

    expect(result.budget_id).toBeTruthy();
    expect(result.available_amount).toBe(1000.0);
    // With historical spending data across 2 months, allocations should be suggested
    expect(result.allocation_count).toBeGreaterThan(0);
    expect(result.allocations.length).toBeGreaterThan(0);
    // Total allocated should not exceed available amount
    expect(result.total_allocated).toBeLessThanOrEqual(1000.0);
    expect(result.total_allocated).toBeGreaterThan(0);
    // Each allocation should reference a valid seed category and have a reason
    for (const alloc of result.allocations) {
      expect(alloc.category_id).toBeTruthy();
      expect(alloc.category_name).toBeTruthy();
      expect(alloc.amount).toBeGreaterThan(0);
      expect(alloc.reason).toBeTruthy();
      expect([
        "P1_bills_due",
        "P2_monthly_contribution",
        "P3_variable_spending",
        "P4_savings",
      ]).toContain(alloc.priority);
    }
    // set_budget_actions should match allocations
    expect(result.set_budget_actions.length).toBe(result.allocation_count);
  });
});

// ── forecast_category_balances ──

describe("forecast_category_balances", () => {
  it("forecasts end-of-month balances per category", async () => {
    const result = (await harness.callTool("forecast_category_balances", {
      month: CURRENT_MONTH,
      history_months: 2,
    })) as {
      budget_id: string;
      month: string;
      days_in_month: number;
      going_negative_count: number;
      going_negative: Array<{ id: string; name: string }>;
      categories: Array<{
        id: string;
        name: string;
        current_balance: number;
        projected_end_balance: number;
        will_go_negative: boolean;
        confidence: string;
      }>;
    };

    expect(result.budget_id).toBeTruthy();
    expect(result.days_in_month).toBe(daysIn(CURRENT_MONTH));
    // Should forecast for the budgeted categories from seed
    expect(result.categories.length).toBeGreaterThan(0);
    for (const cat of result.categories) {
      expect(typeof cat.will_go_negative).toBe("boolean");
      expect(typeof cat.current_balance).toBe("number");
      expect(typeof cat.projected_end_balance).toBe("number");
      expect(["high", "medium", "low"]).toContain(cat.confidence);
    }
    // Verify known seed categories appear
    const catIds = result.categories.map((c) => c.id);
    expect(catIds).toContain("cat-groceries");
    expect(catIds).toContain("cat-rent");
  });
});

// ── get_spending_trends ──

describe("get_spending_trends", () => {
  it("returns multi-month spending trends by category", async () => {
    const result = (await harness.callTool("get_spending_trends", {
      months: 3,
      group_by: "category",
    })) as {
      budget_id: string;
      months: string[];
      total_by_month: Array<{ month: string; total: number }>;
      series: Array<{
        id: string;
        name: string;
        data: Array<{ month: string; amount: number }>;
        trend_direction: string;
      }>;
      summary: {
        highest_growth_category: string | null;
        biggest_reduction_category: string | null;
      };
    };

    expect(result.budget_id).toBeTruthy();
    // Tool uses current date as reference, requesting 3 recent months
    expect(result.months.length).toBe(3);
    expect(result.total_by_month.length).toBe(3);
    // Each month should have transactions — totals should be > 0
    for (const m of result.total_by_month) {
      expect(m.month).toBeTruthy();
      expect(m.total).toBeGreaterThan(0);
    }
    expect(Array.isArray(result.series)).toBe(true);
  });
});

// ── get_income_expense_summary ──

describe("get_income_expense_summary", () => {
  it("returns monthly income vs expense breakdown", async () => {
    const result = (await harness.callTool("get_income_expense_summary", {
      months: 3,
    })) as {
      budget_id: string;
      months: Array<{
        month: string;
        income: number;
        expenses: number;
        net: number;
        savings_rate: number;
      }>;
      averages: {
        avg_income: number;
        avg_expenses: number;
        avg_net: number;
        avg_savings_rate: number;
      };
      trend: {
        direction: string;
      };
    };

    expect(result.budget_id).toBeTruthy();
    // Tool uses current date as reference, so returns 3 recent months
    expect(result.months.length).toBe(3);
    for (const m of result.months) {
      // Seed has income > 0 and expenses > 0 for all 3 months
      expect(m.income).toBeGreaterThan(0);
      expect(m.expenses).toBeGreaterThan(0);
      expect(typeof m.net).toBe("number");
      // Savings rate should be between 0 and 100
      expect(m.savings_rate).toBeGreaterThanOrEqual(0);
      expect(m.savings_rate).toBeLessThanOrEqual(100);
    }
    // Averages should be valid numbers
    expect(typeof result.averages.avg_income).toBe("number");
    expect(typeof result.averages.avg_expenses).toBe("number");
    expect(typeof result.averages.avg_net).toBe("number");
    expect(result.averages.avg_savings_rate).toBeGreaterThanOrEqual(0);
    expect(result.averages.avg_savings_rate).toBeLessThanOrEqual(100);
    expect(["improving", "declining", "stable"]).toContain(
      result.trend.direction,
    );
  });
});

// ── get_spending_breakdown ──

describe("get_spending_breakdown", () => {
  it("breaks down spending by day_of_week", async () => {
    const result = (await harness.callTool("get_spending_breakdown", {
      since_date: TWO_MONTHS_AGO,
      until_date: endOfMonth(CURRENT_MONTH),
      granularity: "day_of_week",
    })) as {
      budget_id: string;
      granularity: string;
      total_spending: number;
      transaction_count: number;
      bucket_count: number;
      buckets: Array<{
        key: string;
        label: string;
        total: number;
        transaction_count: number;
        percentage: number;
      }>;
      insights: {
        highest_bucket: { label: string } | null;
        lowest_bucket: { label: string } | null;
      };
    };

    expect(result.granularity).toBe("day_of_week");
    expect(result.total_spending).toBeGreaterThan(0);
    // 17 outflow transactions in the analytics seed
    expect(result.transaction_count).toBe(17);
    expect(result.buckets.length).toBeGreaterThan(0);
    // Day-of-week buckets should have labels like "Monday", "Tuesday", etc.
    const validDays = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    for (const bucket of result.buckets) {
      expect(validDays).toContain(bucket.label);
      expect(bucket.total).toBeGreaterThan(0);
      // Percentages should be between 0 and 100
      expect(bucket.percentage).toBeGreaterThan(0);
      expect(bucket.percentage).toBeLessThanOrEqual(100);
    }
    // Sum of percentages across all buckets should be ~100
    const totalPct = result.buckets.reduce((s, b) => s + b.percentage, 0);
    expect(totalPct).toBeCloseTo(100, 0);
  });

  it("breaks down spending weekly", async () => {
    const result = (await harness.callTool("get_spending_breakdown", {
      since_date: TWO_MONTHS_AGO,
      until_date: endOfMonth(CURRENT_MONTH),
      granularity: "weekly",
    })) as {
      buckets: Array<{ key: string; label: string; total: number }>;
    };

    expect(result.buckets.length).toBeGreaterThan(0);
  });
});

// ── detect_recurring_charges ──

describe("detect_recurring_charges", () => {
  it("detects recurring payee transactions", async () => {
    const result = (await harness.callTool("detect_recurring_charges", {
      history_months: 6,
      min_occurrences: 3,
    })) as {
      budget_id: string;
      subscription_count: number;
      unmatched_count: number;
      total_monthly_cost: number;
      subscriptions: Array<{
        payee_id: string;
        payee_name: string;
        detected_frequency_label: string;
        occurrence_count: number;
        current_amount: number;
        has_scheduled_transaction: boolean;
      }>;
      create_scheduled_actions: Array<{
        account_id: string;
        payee_id: string;
        frequency: string;
      }>;
    };

    expect(result.budget_id).toBeTruthy();
    // At minimum Landlord (3 monthly txs) and Internet Provider (3 monthly txs) should be detected
    expect(result.subscription_count).toBeGreaterThanOrEqual(2);

    // Landlord: 3 occurrences, monthly, $15.00 each, has scheduled tx (stx-rent)
    const landlord = result.subscriptions.find(
      (s) => s.payee_name === "Landlord",
    );
    expect(landlord).toBeDefined();
    expect(landlord?.occurrence_count).toBe(3);
    expect(landlord?.detected_frequency_label).toBe("monthly");
    expect(landlord?.has_scheduled_transaction).toBe(true);

    // Internet Provider: 3 occurrences, monthly, $0.55 each, has scheduled tx (stx-internet)
    const internet = result.subscriptions.find(
      (s) => s.payee_name === "Internet Provider",
    );
    expect(internet).toBeDefined();
    expect(internet?.occurrence_count).toBe(3);
    expect(internet?.detected_frequency_label).toBe("monthly");
    expect(internet?.has_scheduled_transaction).toBe(true);

    // total_monthly_cost should be positive
    expect(result.total_monthly_cost).toBeGreaterThan(0);
  });
});

// ── detect_anomalies ──

describe("detect_anomalies", () => {
  it("detects anomalous transactions", async () => {
    const result = (await harness.callTool("detect_anomalies", {
      since_date: TWO_MONTHS_AGO,
      sensitivity: "high",
      history_months: 6,
    })) as {
      budget_id: string;
      anomaly_count: number;
      anomalies: Array<{
        transaction_id: string;
        anomaly_type: string;
        severity: string;
        detail: string;
      }>;
    };

    expect(result.budget_id).toBeTruthy();
    // With 6 grocery transactions (tx-2, tx-7, tx-grocery-extra-1/2/3, tx-anomaly=6)
    // the anomaly detector has >= 5 history entries for "Grocery Store" payee,
    // and tx-anomaly at -850000 is a huge outlier vs the ~75000-90000 normal amounts.
    expect(result.anomaly_count).toBeGreaterThanOrEqual(1);
    const groceryAnomaly = result.anomalies.find(
      (a) =>
        a.transaction_id === "tx-anomaly" &&
        a.anomaly_type === "unusual_amount",
    );
    expect(groceryAnomaly).toBeDefined();
    expect(["warning", "alert"]).toContain(groceryAnomaly?.severity);
    expect(groceryAnomaly?.detail).toBeTruthy();
  });
});

// ── diagnose_credit_card_debt ──

describe("diagnose_credit_card_debt", () => {
  it("diagnoses credit card debt and traces sources", async () => {
    const result = (await harness.callTool("diagnose_credit_card_debt", {
      lookback_months: 3,
    })) as {
      budget_id: string;
      cards: Array<{
        account_id: string;
        account_name: string;
        card_balance: number;
        payment_available: number;
        gap: number;
        has_debt: boolean;
        debt_sources: Array<{
          month: string;
          category_name: string;
          overspent_amount: number;
        }>;
      }>;
      total_debt: number;
      set_budget_actions: Array<{
        category_id: string;
        month: string;
        budgeted: number;
      }>;
    };

    expect(result.budget_id).toBeTruthy();
    // Exactly 1 credit card account in the seed
    expect(result.cards).toHaveLength(1);

    const creditCard = result.cards[0];
    expect(creditCard.account_id).toBe("acct-credit");
    expect(creditCard.account_name).toBe("Credit Card");
    // The tool passes card.balance through milliunitsToCurrency(asMilliunits(balance)).
    // Seed balance is -1,000,000 milliunits / 1000 = -1000. Sign is preserved (negative = debt owed).
    expect(creditCard.card_balance).toBe(-1000.0);
    expect(typeof creditCard.payment_available).toBe("number");
    expect(typeof creditCard.gap).toBe("number");
    expect(typeof creditCard.has_debt).toBe("boolean");

    // If there's a gap, we should have set_budget_actions suggestions
    if (creditCard.has_debt) {
      expect(result.set_budget_actions.length).toBeGreaterThan(0);
    }
  });
});
