import { describe, expect, it } from "vitest";
import {
  isCreditCardPaymentsGroup,
  isInternalCategory,
  isInternalMasterGroup,
  isSystemCategoryGroup,
} from "./categories.js";

const masterGroup = {
  name: "Internal Master Category",
  internal: true,
  categories: [
    { name: "Inflow: Ready to Assign", internal: true },
    { name: "Uncategorized", internal: true },
  ],
};

const ccpGroup = {
  name: "Credit Card Payments",
  internal: true,
  categories: [
    { name: "Visa", internal: false },
    { name: "Amex", internal: false },
  ],
};

// Live budgets contain user-created groups that carry internal=true even
// though they are ordinary spending groups (verified on spec 1.86). The
// flag alone must never classify these as system groups.
const pollutedUserGroup = {
  name: "Vacation",
  internal: true,
  categories: [
    { name: "Travel", internal: false },
    { name: "Hotels", internal: false },
  ],
};

const plainUserGroup = {
  name: "Bills",
  internal: false,
  categories: [{ name: "Rent", internal: false }],
};

const creditAccounts = new Set(["Visa", "Amex"]);

describe("isInternalCategory", () => {
  it("uses the category-level flag", () => {
    expect(isInternalCategory({ name: "Inflow", internal: true })).toBe(true);
    expect(isInternalCategory({ name: "Rent", internal: false })).toBe(false);
  });

  it("falls back to the English master group name for flag-less data", () => {
    expect(
      isInternalCategory({ name: "Inflow" }, "Internal Master Category"),
    ).toBe(true);
    expect(isInternalCategory({ name: "Rent" }, "Bills")).toBe(false);
  });
});

describe("isInternalMasterGroup", () => {
  it("matches by contained internal categories", () => {
    expect(isInternalMasterGroup(masterGroup)).toBe(true);
  });

  it("matches localized names via the flag + internal categories", () => {
    expect(
      isInternalMasterGroup({
        name: "Categoría maestra interna",
        internal: true,
        categories: [{ name: "Entrada", internal: true }],
      }),
    ).toBe(true);
  });

  it("rejects internal-flagged user groups without internal categories", () => {
    expect(isInternalMasterGroup(pollutedUserGroup)).toBe(false);
    expect(isInternalMasterGroup(ccpGroup)).toBe(false);
  });

  it("falls back to the English name", () => {
    expect(isInternalMasterGroup({ name: "Internal Master Category" })).toBe(
      true,
    );
  });
});

describe("isCreditCardPaymentsGroup", () => {
  it("matches via the flag plus a credit-account name pairing", () => {
    expect(isCreditCardPaymentsGroup(ccpGroup, creditAccounts)).toBe(true);
  });

  it("rejects internal-flagged user groups without account pairings", () => {
    expect(isCreditCardPaymentsGroup(pollutedUserGroup, creditAccounts)).toBe(
      false,
    );
  });

  it("requires the internal flag for pairing-based matches", () => {
    expect(
      isCreditCardPaymentsGroup(
        {
          name: "Cards I love",
          internal: false,
          categories: [{ name: "Visa" }],
        },
        creditAccounts,
      ),
    ).toBe(false);
  });

  it("falls back to the English name without account context", () => {
    expect(isCreditCardPaymentsGroup({ name: "Credit Card Payments" })).toBe(
      true,
    );
  });
});

describe("isSystemCategoryGroup", () => {
  it("covers both system groups and nothing else", () => {
    expect(isSystemCategoryGroup(masterGroup, creditAccounts)).toBe(true);
    expect(isSystemCategoryGroup(ccpGroup, creditAccounts)).toBe(true);
    expect(isSystemCategoryGroup(pollutedUserGroup, creditAccounts)).toBe(
      false,
    );
    expect(isSystemCategoryGroup(plainUserGroup, creditAccounts)).toBe(false);
  });
});
