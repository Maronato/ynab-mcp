import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FakeBudgetBuilder } from "./fake-ynab/builder.js";
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./harness.js";
import { CURRENT_MONTH, LAST_MONTH, seedStandardBudget } from "./seed.js";

function seedMovementsBudget(builder: FakeBudgetBuilder): void {
  seedStandardBudget(builder);

  builder
    .withMoneyMovementGroup("mmg-1", {
      month: CURRENT_MONTH,
      note: "Cover dining overspend",
    })
    // Grouped move: groceries → dining
    .withMoneyMovement("mm-1", {
      month: CURRENT_MONTH,
      amount: 50000,
      from_category_id: "cat-groceries",
      to_category_id: "cat-dining",
      group_id: "mmg-1",
      moved_at: `${CURRENT_MONTH}T10:00:00Z`,
    })
    // Ungrouped move from Ready to Assign, with its own note
    .withMoneyMovement("mm-2", {
      month: CURRENT_MONTH,
      amount: 100000,
      from_category_id: null,
      to_category_id: "cat-groceries",
      note: "Payday top-up",
      moved_at: `${CURRENT_MONTH}T15:00:00Z`,
    })
    // A move in a previous month
    .withMoneyMovement("mm-3", {
      month: LAST_MONTH,
      amount: 25000,
      from_category_id: "cat-transport",
      to_category_id: "cat-dining",
      moved_at: `${LAST_MONTH}T09:00:00Z`,
    })
    // Soft-deleted: the live API returns these with deleted=true and they
    // must not appear in the audit feed.
    .withMoneyMovement("mm-deleted", {
      month: CURRENT_MONTH,
      amount: 999000,
      from_category_id: "cat-groceries",
      to_category_id: "cat-dining",
      moved_at: `${CURRENT_MONTH}T23:00:00Z`,
      deleted: true,
    });

  builder.build();
}

let harness: IntegrationHarness;

beforeEach(async () => {
  harness = await createIntegrationHarness({ seed: seedMovementsBudget });
});

afterEach(async () => {
  await harness.close();
});

interface MovementsResult {
  budget_id: string;
  month: string | null;
  count: number;
  total_matching: number;
  movements: Array<{
    id: string;
    from_category_id: string | null;
    from_category_name: string;
    to_category_name: string;
    amount: number;
    note: string | null;
    group_id: string | null;
    group_note: string | null;
  }>;
}

describe("get_money_movements", () => {
  it("lists movements newest first with names, RTA, and group notes", async () => {
    const result = (await harness.callTool(
      "get_money_movements",
      {},
    )) as MovementsResult;

    expect(result.total_matching).toBe(3);
    expect(result.movements.map((m) => m.id)).toEqual(["mm-2", "mm-1", "mm-3"]);

    const rtaMove = result.movements[0];
    expect(rtaMove.from_category_id).toBeNull();
    expect(rtaMove.from_category_name).toBe("Ready to Assign");
    expect(rtaMove.to_category_name).toBe("Groceries");
    expect(rtaMove.amount).toBe(100);
    expect(rtaMove.note).toBe("Payday top-up");

    const groupedMove = result.movements[1];
    expect(groupedMove.from_category_name).toBe("Groceries");
    expect(groupedMove.to_category_name).toBe("Dining Out");
    expect(groupedMove.group_id).toBe("mmg-1");
    expect(groupedMove.group_note).toBe("Cover dining overspend");
  });

  it("filters by month via the month-specific endpoints", async () => {
    const result = (await harness.callTool("get_money_movements", {
      month: LAST_MONTH,
    })) as MovementsResult;

    expect(result.month).toBe(LAST_MONTH);
    expect(result.total_matching).toBe(1);
    expect(result.movements[0].id).toBe("mm-3");
    expect(result.movements[0].from_category_name).toBe("Transportation");
  });

  it("omits soft-deleted movements", async () => {
    const result = (await harness.callTool(
      "get_money_movements",
      {},
    )) as MovementsResult;

    expect(result.movements.map((m) => m.id)).not.toContain("mm-deleted");
    expect(result.total_matching).toBe(3);
  });

  it("respects the limit while reporting the full match count", async () => {
    const result = (await harness.callTool("get_money_movements", {
      limit: 1,
    })) as MovementsResult;

    expect(result.count).toBe(1);
    expect(result.total_matching).toBe(3);
    expect(result.movements[0].id).toBe("mm-2");
  });
});
