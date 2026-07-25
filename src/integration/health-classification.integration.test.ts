import { afterEach, describe, expect, it } from "vitest";
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./harness.js";

let harness: IntegrationHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

// The live API sets internal=true on some user-created groups (the finding
// that shaped src/shared/categories.ts). This budget reproduces the shape
// from the PR #2 review: a real payments group AND a polluted-internal user
// group holding a category that happens to share a card's name.
describe("get_budget_health with polluted internal flags", () => {
  it("keeps user-group overspending and does not fabricate card gaps", async () => {
    harness = await createIntegrationHarness({
      seed: (builder) => {
        builder
          .withSettings({ name: "Polluted Flags Budget" })
          .withAccount("acct-platinum", {
            name: "AMEX Platinum",
            type: "creditCard",
            balance: -100000,
          })
          .withCategoryGroup("cg-ccp", "Credit Card Payments", [
            { id: "cat-pay-platinum", name: "AMEX Platinum", balance: 100000 },
          ])
          .withCategoryGroup(
            "cg-fees",
            "Annual card fees",
            [
              {
                id: "cat-fee-platinum",
                name: "AMEX Platinum",
                balance: -69500,
              },
              {
                id: "cat-misc-fees",
                name: "Misc fees",
                balance: -20000,
                goal_type: "NEED",
                goal_under_funded: 15000,
              },
            ],
            // The polluted flag observed on live user groups.
            { internal: true },
          );
      },
    });

    const health = (await harness.callTool("get_budget_health", {})) as {
      overspending: { total: number; categories: Array<{ name: string }> };
      underfunded_targets: { total: number; count: number };
      credit_card_gaps: Array<Record<string, unknown>>;
    };

    // The fee group's real overspending must not vanish...
    expect(health.overspending.total).toBeCloseTo(89.5);
    expect(health.overspending.categories).toHaveLength(2);
    // ...its underfunded target must still be reported...
    expect(health.underfunded_targets.count).toBe(1);
    // ...and the fully-funded card must not show a fabricated gap.
    expect(health.credit_card_gaps).toHaveLength(0);
  });
});
