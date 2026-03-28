import { describe, expect, it } from "vitest";
import {
  analyzeTransactions,
  type CategorizationSuggestion,
  type FlatCategory,
  findSimilarPayees,
  normalizePayeeName,
  type TargetTransaction,
  tokenSimilarity,
} from "./categorize.js";
import type { PayeeProfile } from "./payee-profiles.js";

const CATEGORIES: FlatCategory[] = [
  {
    id: "cat-groceries",
    name: "Groceries",
    group_id: "g-everyday",
    group_name: "Everyday",
  },
  {
    id: "cat-dining",
    name: "Dining Out",
    group_id: "g-everyday",
    group_name: "Everyday",
  },
  {
    id: "cat-subs",
    name: "Subscriptions",
    group_id: "g-bills",
    group_name: "Bills",
  },
  {
    id: "cat-electric",
    name: "Electric",
    group_id: "g-bills",
    group_name: "Bills",
  },
  {
    id: "cat-household",
    name: "Household",
    group_id: "g-home",
    group_name: "Home",
  },
];

function makeProfile(overrides: Partial<PayeeProfile> = {}): PayeeProfile {
  return {
    payee_id: "p1",
    payee_name: "Test Payee",
    category_counts: new Map(),
    recency_weighted: new Map(),
    total_count: 0,
    most_recent_category_id: null,
    most_recent_date: null,
    amount_buckets: [],
    ...overrides,
  };
}

function makeTarget(
  overrides: Partial<TargetTransaction> = {},
): TargetTransaction {
  return {
    id: "tx-1",
    date: "2026-03-25",
    amount: -50000,
    payee_id: "p1",
    payee_name: "Test Payee",
    category_id: null,
    category_name: null,
    memo: null,
    approved: false,
    ...overrides,
  };
}

function analyze(
  targets: TargetTransaction[],
  profiles: Map<string, PayeeProfile>,
  scheduled: Array<{
    id: string;
    payee_id: string | null;
    category_id: string | null;
    amount: number;
    frequency: string;
  }> = [],
): CategorizationSuggestion[] {
  const payeeNames = new Map<string, string>();
  for (const p of profiles.values()) {
    payeeNames.set(p.payee_id, p.payee_name);
  }
  return analyzeTransactions(
    targets,
    profiles,
    scheduled,
    CATEGORIES,
    payeeNames,
  );
}

describe("analyzeTransactions", () => {
  describe("definitive confidence", () => {
    it("assigns definitive when payee history is strong (>90%, 5+ txs)", () => {
      const profiles = new Map([
        [
          "p1",
          makeProfile({
            payee_id: "p1",
            category_counts: new Map([
              ["cat-groceries", 19],
              ["cat-household", 1],
            ]),
            recency_weighted: new Map([
              ["cat-groceries", 15],
              ["cat-household", 0.5],
            ]),
            total_count: 20,
          }),
        ],
      ]);

      const [result] = analyze([makeTarget()], profiles);

      expect(result.confidence).toBe("definitive");
      expect(result.suggested_category_id).toBe("cat-groceries");
      expect(result.method).toBe("payee_history");
    });

    it("boosts to definitive when scheduled match agrees with history", () => {
      // 75% confidence, 4 txs — not enough for definitive on its own
      const profiles = new Map([
        [
          "p1",
          makeProfile({
            payee_id: "p1",
            category_counts: new Map([
              ["cat-subs", 3],
              ["cat-dining", 1],
            ]),
            recency_weighted: new Map([
              ["cat-subs", 2.5],
              ["cat-dining", 0.5],
            ]),
            total_count: 4,
          }),
        ],
      ]);

      const scheduled = [
        {
          id: "stx-1",
          payee_id: "p1",
          category_id: "cat-subs",
          amount: -9990,
          frequency: "monthly",
        },
      ];

      const [result] = analyze(
        [makeTarget({ amount: -9990 })],
        profiles,
        scheduled,
      );

      expect(result.confidence).toBe("definitive");
      expect(result.method).toBe("scheduled_match+payee_history");
    });
  });

  describe("high confidence", () => {
    it("assigns high for scheduled match without strong history", () => {
      const profiles = new Map<string, PayeeProfile>();

      const scheduled = [
        {
          id: "stx-1",
          payee_id: "p1",
          category_id: "cat-electric",
          amount: -75000,
          frequency: "monthly",
        },
      ];

      const [result] = analyze(
        [makeTarget({ amount: -75000 })],
        profiles,
        scheduled,
      );

      expect(result.confidence).toBe("high");
      expect(result.suggested_category_id).toBe("cat-electric");
      expect(result.method).toBe("scheduled_match");
    });

    it("assigns high for moderate payee history (>70%, 3+ txs)", () => {
      const profiles = new Map([
        [
          "p1",
          makeProfile({
            payee_id: "p1",
            category_counts: new Map([
              ["cat-dining", 3],
              ["cat-groceries", 1],
            ]),
            recency_weighted: new Map([
              ["cat-dining", 2.5],
              ["cat-groceries", 0.5],
            ]),
            total_count: 4,
          }),
        ],
      ]);

      const [result] = analyze([makeTarget()], profiles);

      expect(result.confidence).toBe("high");
      expect(result.suggested_category_id).toBe("cat-dining");
    });
  });

  describe("medium confidence", () => {
    it("assigns medium for weak payee history (40-70%)", () => {
      const profiles = new Map([
        [
          "p1",
          makeProfile({
            payee_id: "p1",
            category_counts: new Map([
              ["cat-dining", 3],
              ["cat-groceries", 2],
            ]),
            recency_weighted: new Map([
              ["cat-dining", 2],
              ["cat-groceries", 1.5],
            ]),
            total_count: 5,
          }),
        ],
      ]);

      const [result] = analyze([makeTarget()], profiles);

      expect(result.confidence).toBe("medium");
    });

    it("flags YNAB auto-categorization that disagrees with history", () => {
      const profiles = new Map([
        [
          "p1",
          makeProfile({
            payee_id: "p1",
            category_counts: new Map([["cat-groceries", 2]]),
            recency_weighted: new Map([["cat-groceries", 2]]),
            total_count: 2,
          }),
        ],
      ]);

      const [result] = analyze(
        [
          makeTarget({
            category_id: "cat-household",
            category_name: "Household",
            approved: false,
          }),
        ],
        profiles,
      );

      expect(result.confidence).toBe("medium");
      expect(result.suggested_category_id).toBe("cat-groceries");
      expect(result.method).toBe("payee_history_vs_ynab");
      expect(result.reasoning).toContain("YNAB auto-assigned Household");
      expect(result.reasoning).toContain("Groceries");
    });

    it("uses YNAB auto-categorization when no history exists", () => {
      const profiles = new Map<string, PayeeProfile>();

      const [result] = analyze(
        [
          makeTarget({
            category_id: "cat-dining",
            category_name: "Dining Out",
            approved: false,
          }),
        ],
        profiles,
      );

      expect(result.confidence).toBe("medium");
      expect(result.suggested_category_id).toBe("cat-dining");
      expect(result.method).toBe("ynab_auto");
    });
  });

  describe("low confidence", () => {
    it("assigns low for completely new payee with no signals", () => {
      const profiles = new Map<string, PayeeProfile>();

      const [result] = analyze(
        [makeTarget({ payee_id: "unknown", payee_name: "Unknown Store" })],
        profiles,
      );

      expect(result.confidence).toBe("low");
    });
  });

  describe("similar payees", () => {
    it("uses similar payee profiles for new payees", () => {
      const profiles = new Map([
        [
          "p-known",
          makeProfile({
            payee_id: "p-known",
            payee_name: "whole foods market",
            category_counts: new Map([["cat-groceries", 10]]),
            recency_weighted: new Map([["cat-groceries", 8]]),
            total_count: 10,
          }),
        ],
      ]);
      const payeeNames = new Map([["p-known", "whole foods market"]]);

      const result = analyzeTransactions(
        [
          makeTarget({
            payee_id: "p-new",
            payee_name: "whole foods mkt",
          }),
        ],
        profiles,
        [],
        CATEGORIES,
        payeeNames,
      );

      expect(result[0].confidence).toBe("medium");
      expect(result[0].suggested_category_id).toBe("cat-groceries");
      expect(result[0].method).toBe("similar_payee");
    });
  });

  it("processes multiple transactions", () => {
    const profiles = new Map([
      [
        "p1",
        makeProfile({
          payee_id: "p1",
          category_counts: new Map([["cat-groceries", 20]]),
          recency_weighted: new Map([["cat-groceries", 15]]),
          total_count: 20,
        }),
      ],
    ]);

    const results = analyze(
      [
        makeTarget({ id: "tx-1" }),
        makeTarget({ id: "tx-2", payee_id: "p-unknown", payee_name: "New" }),
      ],
      profiles,
    );

    expect(results).toHaveLength(2);
    expect(results[0].confidence).toBe("definitive");
    expect(results[1].confidence).toBe("low");
  });
});

describe("normalizePayeeName", () => {
  it("strips trailing number codes", () => {
    expect(normalizePayeeName("WHOLEFDS MKT #2087")).toBe("wholefds mkt");
  });

  it("strips bank prefixes", () => {
    expect(normalizePayeeName("POS DEBIT Whole Foods")).toBe("whole foods");
  });

  it("strips ZIP codes", () => {
    expect(normalizePayeeName("Store Name TX 78701")).toBe("store name");
  });

  it("strips long numbers", () => {
    expect(normalizePayeeName("AMZN MKTP US 12345678")).toBe("amzn mktp us");
  });

  it("handles SQ* and TST* prefixes", () => {
    expect(normalizePayeeName("SQ *COFFEE SHOP")).toBe("coffee shop");
  });
});

describe("tokenSimilarity", () => {
  it("returns 1.0 for identical strings", () => {
    expect(tokenSimilarity("whole foods", "whole foods")).toBe(1.0);
  });

  it("returns 0 for completely different strings", () => {
    expect(tokenSimilarity("whole foods", "electric company")).toBe(0);
  });

  it("returns partial score for overlapping tokens", () => {
    const score = tokenSimilarity("whole foods market", "whole foods");
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1.0);
  });

  it("returns 0 for empty strings", () => {
    expect(tokenSimilarity("", "something")).toBe(0);
  });
});

describe("findSimilarPayees", () => {
  it("finds similar payees above threshold", () => {
    const profiles = new Map([
      [
        "p1",
        makeProfile({
          payee_id: "p1",
          payee_name: "whole foods market",
          total_count: 5,
        }),
      ],
      [
        "p2",
        makeProfile({
          payee_id: "p2",
          payee_name: "electric company",
          total_count: 3,
        }),
      ],
    ]);
    const payeeNames = new Map([
      ["p1", "whole foods market"],
      ["p2", "electric company"],
    ]);

    const results = findSimilarPayees(
      "whole foods mkt",
      payeeNames,
      profiles,
      3,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].profile.payee_id).toBe("p1");
  });

  it("returns empty for no matches", () => {
    const profiles = new Map([
      [
        "p1",
        makeProfile({
          payee_id: "p1",
          payee_name: "totally different store",
          total_count: 5,
        }),
      ],
    ]);
    const payeeNames = new Map([["p1", "totally different store"]]);

    const results = findSimilarPayees("amazon prime", payeeNames, profiles, 3);

    expect(results).toEqual([]);
  });

  it("skips payees with no profile data", () => {
    const profiles = new Map([
      [
        "p1",
        makeProfile({
          payee_id: "p1",
          payee_name: "whole foods",
          total_count: 0,
        }),
      ],
    ]);
    const payeeNames = new Map([["p1", "whole foods"]]);

    const results = findSimilarPayees(
      "whole foods mkt",
      payeeNames,
      profiles,
      3,
    );
    expect(results).toEqual([]);
  });
});
