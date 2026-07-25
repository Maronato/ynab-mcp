import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createIntegrationHarness,
  type IntegrationHarness,
} from "./harness.js";
import { seedStandardBudget } from "./seed.js";

let harness: IntegrationHarness;

afterEach(async () => {
  await harness.close();
});

describe("write timeouts", () => {
  it("aborts the underlying request and leaves an ambiguous pending marker", async () => {
    harness = await createIntegrationHarness({
      seed: seedStandardBudget,
      timeoutMs: 200,
    });

    harness.fake.injectFault({
      method: "POST",
      pathIncludes: "/transactions",
      delayMs: 5_000,
      times: 1,
    });

    await expect(
      harness.callTool("create_transactions", {
        transactions: [
          {
            account_id: "acct-checking",
            date: "2025-01-15",
            amount: -12.34,
            category_id: "cat-groceries",
            payee_name: "Timeout Test",
          },
        ],
      }),
    ).rejects.toThrow(/timed out after 0\.2 seconds/);

    // The fetch-level abort must actually reach the server: its response
    // stream closes before anything was written.
    await expect
      .poll(() => harness.fake.stats.abortedRequests, { timeout: 2_000 })
      .toBeGreaterThanOrEqual(1);

    // The pending marker survives with an explanatory note, so the
    // ambiguous outcome is visible in list_undo_history.
    const history = (await harness.callTool("list_undo_history", {})) as {
      warning?: string;
      pending_operations?: Array<{ description: string; note?: string }>;
    };
    expect(history.warning).toMatch(/interrupted/);
    expect(history.pending_operations).toHaveLength(1);
    expect(history.pending_operations?.[0].description).toMatch(
      /Creating 1 transaction/,
    );
    expect(history.pending_operations?.[0].note).toMatch(
      /unknown outcome.*may have been applied/s,
    );
  });

  it("clears the pending marker on definitive API rejections", async () => {
    harness = await createIntegrationHarness({
      seed: seedStandardBudget,
      timeoutMs: 200,
    });

    harness.fake.injectFault({
      method: "POST",
      pathIncludes: "/transactions",
      status: 400,
      body: {
        error: { id: "400", name: "bad_request", detail: "Injected rejection" },
      },
      times: 1,
    });

    await expect(
      harness.callTool("create_transactions", {
        transactions: [
          {
            account_id: "acct-checking",
            date: "2025-01-15",
            amount: -12.34,
            category_id: "cat-groceries",
          },
        ],
      }),
    ).rejects.toThrow();

    const history = (await harness.callTool("list_undo_history", {})) as {
      warning?: string;
      pending_operations?: Array<{ description: string }>;
    };
    expect(history.warning).toBeUndefined();
    expect(history.pending_operations).toBeUndefined();
  });
});

describe("split-phantom cleanup debris", () => {
  it("records undoable entries for flush transactions whose delete fails", async () => {
    harness = await createIntegrationHarness({
      seed: seedStandardBudget,
      maxRetries: 0,
    });

    const created = (await harness.callTool("create_transactions", {
      transactions: [
        {
          account_id: "acct-checking",
          date: "2025-01-15",
          amount: -100.0,
          memo: "Debris test split",
          subtransactions: [
            { amount: -60.0, category_id: "cat-groceries" },
            { amount: -40.0, category_id: "cat-dining" },
          ],
        },
      ],
    })) as { transactions: Array<{ id: string }> };
    const splitId = created.transactions[0].id;

    // Let the primary delete through, then fail the flush-transaction
    // deletes (the -0.01 workaround cleanups) persistently.
    harness.fake.injectFault({
      method: "DELETE",
      pathIncludes: "/transactions/",
      status: 500,
      skip: 1,
    });

    // The tool call itself must succeed: the split was deleted.
    await harness.callTool("delete_transactions", {
      transaction_ids: [splitId],
    });

    // Both stray cents remain in the budget...
    const search = (await harness.callTool("search_transactions", {
      queries: [{ amount_max: -0.005, amount_min: -0.015 }],
    })) as {
      result_sets: Array<{ transactions: Array<{ id: string }> }>;
    };
    expect(search.result_sets[0].transactions).toHaveLength(2);

    // ...and each is recorded as an undoable create.
    const history = (await harness.callTool("list_undo_history", {})) as {
      entries: Array<{ id: string; description: string }>;
    };
    const debrisEntries = history.entries.filter((e) =>
      /cleanup transaction .* could not be deleted/.test(e.description),
    );
    expect(debrisEntries).toHaveLength(2);

    // Undoing the recorded entries removes the debris once the API recovers.
    harness.fake.clearFaults();
    await harness.callTool("undo_operations", {
      undo_history_ids: debrisEntries.map((e) => e.id),
    });

    const searchAfter = (await harness.callTool("search_transactions", {
      queries: [{ amount_max: -0.005, amount_min: -0.015 }],
    })) as {
      result_sets: Array<{ transactions: Array<{ id: string }> }>;
    };
    expect(searchAfter.result_sets[0].transactions).toHaveLength(0);
  });
});

describe("write-ambiguity bookkeeping", () => {
  it("keeps the ambiguous marker when a batched tool times out per-item", async () => {
    harness = await createIntegrationHarness({
      seed: seedStandardBudget,
      timeoutMs: 200,
    });

    const search = (await harness.callTool("search_transactions", {
      queries: [{}],
    })) as {
      result_sets: Array<{ transactions: Array<{ id: string }> }>;
    };
    const txId = search.result_sets[0].transactions[0].id;

    harness.fake.injectFault({
      method: "DELETE",
      pathIncludes: "/transactions/",
      delayMs: 5_000,
      times: 1,
    });

    // Batched tools fold per-item errors into result rows instead of
    // throwing — the marker must survive anyway.
    const result = (await harness.callTool("delete_transactions", {
      transaction_ids: [txId],
    })) as {
      results: Array<{ status: string; message?: string }>;
    };
    expect(result.results[0].status).toBe("error");
    expect(result.results[0].message).toMatch(/timed out/);

    const history = (await harness.callTool("list_undo_history", {})) as {
      warning?: string;
      pending_operations?: Array<{ note?: string }>;
    };
    expect(history.pending_operations).toHaveLength(1);
    expect(history.pending_operations?.[0].note).toMatch(/unknown outcome/);
  });

  it("treats a dropped connection during a write as ambiguous", async () => {
    harness = await createIntegrationHarness({ seed: seedStandardBudget });

    harness.fake.injectFault({
      method: "POST",
      pathIncludes: "/transactions",
      destroySocket: true,
      times: 1,
    });

    await expect(
      harness.callTool("create_transactions", {
        transactions: [
          {
            account_id: "acct-checking",
            date: "2025-01-15",
            amount: -5.0,
            category_id: "cat-groceries",
          },
        ],
      }),
    ).rejects.toThrow(/fetch failed|socket|terminated/i);

    const history = (await harness.callTool("list_undo_history", {})) as {
      pending_operations?: Array<{ note?: string }>;
    };
    expect(history.pending_operations).toHaveLength(1);
    expect(history.pending_operations?.[0].note).toMatch(/unknown outcome/);
  });

  it("keeps a truthful marker when the server applied the write before the abort", async () => {
    harness = await createIntegrationHarness({
      seed: seedStandardBudget,
      timeoutMs: 200,
    });

    harness.fake.injectFault({
      method: "POST",
      pathIncludes: "/transactions",
      delayAfterApplyMs: 5_000,
      times: 1,
    });

    await expect(
      harness.callTool("create_transactions", {
        transactions: [
          {
            account_id: "acct-checking",
            date: "2025-01-15",
            amount: -6.0,
            memo: "Truthful ambiguity test",
            category_id: "cat-groceries",
          },
        ],
      }),
    ).rejects.toThrow(/timed out/);

    // The server DID apply the write — the marker is not a false alarm.
    harness.fake.clearFaults();
    const search = (await harness.callTool("search_transactions", {
      queries: [{ memo_contains: "Truthful ambiguity" }],
    })) as {
      result_sets: Array<{ transactions: Array<{ id: string }> }>;
    };
    expect(search.result_sets[0].transactions).toHaveLength(1);

    const history = (await harness.callTool("list_undo_history", {})) as {
      pending_operations?: Array<{ note?: string }>;
    };
    expect(history.pending_operations).toHaveLength(1);
  });

  it("does not fail a delete whose phantom-flush create fails", async () => {
    harness = await createIntegrationHarness({
      seed: seedStandardBudget,
      maxRetries: 0,
    });

    const created = (await harness.callTool("create_transactions", {
      transactions: [
        {
          account_id: "acct-checking",
          date: "2025-01-15",
          amount: -100.0,
          memo: "Flush-create failure split",
          subtransactions: [
            { amount: -60.0, category_id: "cat-groceries" },
            { amount: -40.0, category_id: "cat-dining" },
          ],
        },
      ],
    })) as { transactions: Array<{ id: string }> };
    const splitId = created.transactions[0].id;

    // Every POST from here on fails — including the phantom-flush create.
    harness.fake.injectFault({
      method: "POST",
      pathIncludes: "/transactions",
      status: 500,
    });

    const result = (await harness.callTool("delete_transactions", {
      transaction_ids: [splitId],
    })) as {
      results: Array<{ status: string }>;
      undo_history_ids: string[];
    };
    expect(result.results[0].status).toBe("deleted");
    expect(result.undo_history_ids.length).toBeGreaterThan(0);

    harness.fake.clearFaults();
    const search = (await harness.callTool("search_transactions", {
      queries: [{ memo_contains: "Flush-create failure" }],
    })) as {
      result_sets: Array<{ transactions: Array<{ id: string }> }>;
    };
    expect(search.result_sets[0].transactions).toHaveLength(0);
  });

  it("marks pending when an undo write fails ambiguously", async () => {
    harness = await createIntegrationHarness({
      seed: seedStandardBudget,
      timeoutMs: 200,
    });

    const created = (await harness.callTool("create_transactions", {
      transactions: [
        {
          account_id: "acct-checking",
          date: "2025-01-15",
          amount: -7.0,
          memo: "Undo ambiguity test",
          category_id: "cat-groceries",
        },
      ],
    })) as { transactions: Array<{ id: string }> };

    const deleted = (await harness.callTool("delete_transactions", {
      transaction_ids: [created.transactions[0].id],
    })) as { undo_history_ids: string[] };
    const deleteEntryId = deleted.undo_history_ids[0];

    // Undoing the delete re-creates the transaction (a POST) — time it out.
    harness.fake.injectFault({
      method: "POST",
      pathIncludes: "/transactions",
      delayMs: 5_000,
      times: 1,
    });

    const undo = (await harness.callTool("undo_operations", {
      undo_history_ids: [deleteEntryId],
    })) as { results: Array<{ status: string; message?: string }> };
    expect(undo.results[0].status).toBe("error");

    const history = (await harness.callTool("list_undo_history", {})) as {
      pending_operations?: Array<{ description: string; note?: string }>;
    };
    expect(history.pending_operations).toHaveLength(1);
    expect(history.pending_operations?.[0].description).toMatch(/Undoing/);
    expect(history.pending_operations?.[0].note).toMatch(
      /may have been applied/,
    );
  });
});

describe("crash recovery", () => {
  it("surfaces pending operations left behind by a crashed process", async () => {
    harness = await createIntegrationHarness({ seed: seedStandardBudget });

    // Simulate a server that died mid-write: its pending marker is still on
    // disk when this (fresh) server reads the shared data directory.
    const historyDir = join(harness.dataDirectory, "history");
    await mkdir(historyDir, { recursive: true });
    await writeFile(
      join(historyDir, "budget-1.json"),
      JSON.stringify({
        entries: [],
        id_mappings: {},
        pending_operations: [
          {
            id: "budget-1::pending::12345",
            budget_id: "budget-1",
            timestamp: new Date().toISOString(),
            description: "Creating 2 transactions",
          },
        ],
      }),
      "utf8",
    );

    const history = (await harness.callTool("list_undo_history", {})) as {
      warning?: string;
      pending_operations?: Array<{ description: string }>;
    };
    expect(history.warning).toMatch(/interrupted/);
    expect(history.pending_operations?.[0].description).toBe(
      "Creating 2 transactions",
    );
  });
});

describe("rate limiting", () => {
  it("intercepts 429s and blocks subsequent calls locally", async () => {
    harness = await createIntegrationHarness({ seed: seedStandardBudget });

    harness.fake.injectFault({
      status: 429,
      body: {
        error: {
          id: "429",
          name: "too_many_requests",
          detail: "Too many requests",
        },
      },
    });

    // The 429 surfaces as the client's rate-limit message (not the SDK's
    // generic FetchError wrapper), and marks the window exhausted.
    await expect(harness.callTool("get_accounts", {})).rejects.toThrow(
      /rate limit exceeded \(429\)/,
    );

    // Follow-up calls are refused locally without touching the API.
    const requestsAfterFirst = harness.fake.stats.totalRequests;
    await expect(harness.callTool("get_accounts", {})).rejects.toThrow(
      /rate limit/i,
    );
    expect(harness.fake.stats.totalRequests).toBe(requestsAfterFirst);
  });
});

describe("read retries", () => {
  it("retries transient 5xx failures on reads", async () => {
    harness = await createIntegrationHarness({
      seed: seedStandardBudget,
      maxRetries: 2,
    });

    harness.fake.injectFault({
      method: "GET",
      pathIncludes: "/accounts",
      status: 503,
      times: 1,
    });

    const result = (await harness.callTool("get_accounts", {})) as {
      accounts: Array<{ id: string }>;
    };
    expect(result.accounts.length).toBeGreaterThan(0);
  });

  it("gives up after exhausting retries", async () => {
    harness = await createIntegrationHarness({
      seed: seedStandardBudget,
      maxRetries: 1,
    });

    harness.fake.injectFault({
      method: "GET",
      pathIncludes: "/accounts",
      status: 503,
    });

    await expect(harness.callTool("get_accounts", {})).rejects.toThrow();
  });
});
