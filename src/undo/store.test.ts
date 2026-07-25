import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockUndoEntry } from "../test-utils.js";
import { UndoStore } from "./store.js";

let dataDir: string;
let store: UndoStore;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "undo-store-test-"));
  store = new UndoStore(dataDir);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const BUDGET_ID = "budget-1";

function entry(id: string, overrides: Record<string, unknown> = {}) {
  return createMockUndoEntry({
    id,
    budget_id: BUDGET_ID,
    timestamp: new Date().toISOString(),
    ...overrides,
  });
}

describe("appendEntries and persistence", () => {
  it("creates history file and entries can be read back", async () => {
    const e = entry("budget-1::1::aaa");
    await store.appendEntries(BUDGET_ID, [e]);

    const { entries: result } = await store.listEntries(BUDGET_ID, {
      limit: 100,
      includeUndone: false,
    });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("budget-1::1::aaa");
  });

  it("writes entries and id mappings in one append operation", async () => {
    const e = entry("budget-1::1::replace", {
      undo_action: {
        type: "update",
        entity_type: "transaction",
        entity_id: "old-id",
        expected_state: {},
        restore_state: {},
      },
    });

    await store.appendEntries(
      BUDGET_ID,
      [e],
      [{ sourceEntityId: "old-id", targetEntityId: "new-id" }],
    );

    const { entries } = await store.listEntries(BUDGET_ID, {
      limit: 100,
      includeUndone: true,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("budget-1::1::replace");
    expect(await store.resolveMappedId(BUDGET_ID, "old-id")).toBe("new-id");
  });

  it("prepends new entries (most recent first)", async () => {
    const e1 = entry("budget-1::1::first");
    const e2 = entry("budget-1::2::second");

    await store.appendEntries(BUDGET_ID, [e1]);
    await store.appendEntries(BUDGET_ID, [e2]);

    const { entries: result } = await store.listEntries(BUDGET_ID, {
      limit: 100,
      includeUndone: false,
    });

    expect(result[0].id).toBe("budget-1::2::second");
    expect(result[1].id).toBe("budget-1::1::first");
  });

  it("caps total entries at maxEntriesPerBudget", async () => {
    const smallStore = new UndoStore(dataDir, 3);

    for (let i = 0; i < 5; i++) {
      await smallStore.appendEntries(BUDGET_ID, [entry(`budget-1::${i}::e`)]);
    }

    const { entries: result } = await smallStore.listEntries(BUDGET_ID, {
      limit: 100,
      includeUndone: true,
    });

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe("budget-1::4::e");
  });
});

describe("listEntries", () => {
  it("pages with offset and reports the total", async () => {
    for (let i = 0; i < 5; i++) {
      await store.appendEntries(BUDGET_ID, [entry(`budget-1::${i}::page`)]);
    }

    const page = await store.listEntries(BUDGET_ID, {
      limit: 2,
      offset: 2,
      includeUndone: true,
    });

    expect(page.total).toBe(5);
    expect(page.entries).toHaveLength(2);
    // Entries are newest-first; offset 2 skips the two most recent
    expect(page.entries[0].id).toBe("budget-1::2::page");
    expect(page.entries[1].id).toBe("budget-1::1::page");
  });

  it("excludes undone entries when includeUndone is false", async () => {
    await store.appendEntries(BUDGET_ID, [
      entry("budget-1::1::a"),
      entry("budget-1::2::b"),
    ]);
    await store.markEntriesUndone(BUDGET_ID, ["budget-1::1::a"]);

    const { entries: result } = await store.listEntries(BUDGET_ID, {
      limit: 100,
      includeUndone: false,
    });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("budget-1::2::b");
  });

  it("includes undone entries when includeUndone is true", async () => {
    await store.appendEntries(BUDGET_ID, [entry("budget-1::1::a")]);
    await store.markEntriesUndone(BUDGET_ID, ["budget-1::1::a"]);

    const { entries: result } = await store.listEntries(BUDGET_ID, {
      limit: 100,
      includeUndone: true,
    });

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("undone");
  });

  it("respects the limit parameter", async () => {
    await store.appendEntries(BUDGET_ID, [
      entry("budget-1::1::a"),
      entry("budget-1::2::b"),
      entry("budget-1::3::c"),
    ]);

    const { entries: result } = await store.listEntries(BUDGET_ID, {
      limit: 2,
      includeUndone: false,
    });

    expect(result).toHaveLength(2);
  });

  it("returns empty array for a budget with no history", async () => {
    const { entries: result } = await store.listEntries("nonexistent", {
      limit: 100,
      includeUndone: false,
    });

    expect(result).toEqual([]);
  });

  it("returns early for empty append without writing history files", async () => {
    const cleanupStore = new UndoStore(dataDir);
    await cleanupStore.appendEntries(BUDGET_ID, []);

    const historyDir = join(dataDir, "history");
    await expect(readdir(historyDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("getEntriesByIds", () => {
  it("returns entries in the order of requested IDs", async () => {
    await store.appendEntries(BUDGET_ID, [
      entry("budget-1::1::a"),
      entry("budget-1::2::b"),
      entry("budget-1::3::c"),
    ]);

    const result = await store.getEntriesByIds(BUDGET_ID, [
      "budget-1::3::c",
      "budget-1::1::a",
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe("budget-1::3::c");
    expect(result[1]?.id).toBe("budget-1::1::a");
  });

  it("returns undefined for IDs that do not exist", async () => {
    await store.appendEntries(BUDGET_ID, [entry("budget-1::1::a")]);

    const result = await store.getEntriesByIds(BUDGET_ID, [
      "budget-1::1::a",
      "budget-1::nonexistent",
    ]);

    expect(result[0]?.id).toBe("budget-1::1::a");
    expect(result[1]).toBeUndefined();
  });
});

describe("markEntriesUndone", () => {
  it("sets matching entries to undone and leaves others", async () => {
    await store.appendEntries(BUDGET_ID, [
      entry("budget-1::1::a"),
      entry("budget-1::2::b"),
    ]);

    await store.markEntriesUndone(BUDGET_ID, ["budget-1::1::a"]);

    const { entries: all } = await store.listEntries(BUDGET_ID, {
      limit: 100,
      includeUndone: true,
    });

    const undone = all.find((e) => e.id === "budget-1::1::a");
    const active = all.find((e) => e.id === "budget-1::2::b");

    expect(undone?.status).toBe("undone");
    expect(active?.status).toBe("active");
  });

  it("no-ops for empty array", async () => {
    await store.appendEntries(BUDGET_ID, [entry("budget-1::1::a")]);
    await store.markEntriesUndone(BUDGET_ID, []);

    const { entries: result } = await store.listEntries(BUDGET_ID, {
      limit: 100,
      includeUndone: false,
    });

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("active");
  });
});

describe("resolveMappedId", () => {
  it("returns original ID when no mapping exists", async () => {
    const result = await store.resolveMappedId(BUDGET_ID, "entity-1");
    expect(result).toBe("entity-1");
  });

  it("follows a single-hop mapping", async () => {
    await store.updateIdMappings(BUDGET_ID, "old-id", "new-id");
    const result = await store.resolveMappedId(BUDGET_ID, "old-id");
    expect(result).toBe("new-id");
  });

  it("follows a multi-hop chain", async () => {
    await store.updateIdMappings(BUDGET_ID, "id-a", "id-b");
    await store.updateIdMappings(BUDGET_ID, "id-b", "id-c");

    const result = await store.resolveMappedId(BUDGET_ID, "id-a");
    expect(result).toBe("id-c");
  });

  it("handles cycles safely without infinite loop", async () => {
    // Manually create a cycle by writing raw data
    const { mkdir, writeFile } = await import("node:fs/promises");
    const historyDir = join(dataDir, "history");
    await mkdir(historyDir, { recursive: true });
    const filePath = join(historyDir, `${encodeURIComponent(BUDGET_ID)}.json`);
    await writeFile(
      filePath,
      JSON.stringify({
        entries: [],
        id_mappings: { "id-a": "id-b", "id-b": "id-a" },
      }),
    );

    // Should terminate without hanging
    const result = await store.resolveMappedId(BUDGET_ID, "id-a");
    expect(["id-a", "id-b"]).toContain(result);
  });
});

describe("updateIdMappings", () => {
  it("creates a new mapping", async () => {
    await store.updateIdMappings(BUDGET_ID, "src", "target");
    const result = await store.resolveMappedId(BUDGET_ID, "src");
    expect(result).toBe("target");
  });

  it("collapses transitive chains", async () => {
    await store.updateIdMappings(BUDGET_ID, "x", "a");
    await store.updateIdMappings(BUDGET_ID, "a", "b");

    // x should now resolve directly to b
    const result = await store.resolveMappedId(BUDGET_ID, "x");
    expect(result).toBe("b");
  });
});

describe("concurrency", () => {
  it("serializes concurrent operations on the same budget", async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      entry(`budget-1::${i}::e`),
    );

    // Append all concurrently
    await Promise.all(entries.map((e) => store.appendEntries(BUDGET_ID, [e])));

    const { entries: result } = await store.listEntries(BUDGET_ID, {
      limit: 100,
      includeUndone: true,
    });

    // All 10 entries should be present (no data loss from races)
    expect(result).toHaveLength(10);
  });
});

describe("error handling", () => {
  it("returns default empty history for missing file", async () => {
    const { entries: result } = await store.listEntries("no-such-budget", {
      limit: 100,
      includeUndone: true,
    });

    expect(result).toEqual([]);
  });

  it("recovers from corrupt JSON by quarantining the file", async () => {
    const { mkdir } = await import("node:fs/promises");
    const historyDir = join(dataDir, "history");
    await mkdir(historyDir, { recursive: true });
    const filePath = join(historyDir, `${encodeURIComponent(BUDGET_ID)}.json`);
    await writeFile(filePath, "not valid json{{{");

    const { entries: result } = await store.listEntries(BUDGET_ID, {
      limit: 100,
      includeUndone: true,
    });

    expect(result).toEqual([]);

    const files = await readdir(historyDir);
    expect(files).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          new RegExp(`^${encodeURIComponent(BUDGET_ID)}\\.json\\.corrupt-`),
        ),
      ]),
    );
  });
});

describe("housekeeping", () => {
  it("expires pending operations older than the age cutoff", async () => {
    const fresh = await store.markPending(BUDGET_ID, "fresh operation");

    // Inject stale pending ops directly into the history file: one from
    // yesterday (kept — the cutoff errs long) and one from last week
    // (expired).
    const filePath = join(dataDir, "history", `${BUDGET_ID}.json`);
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    raw.pending_operations.push(
      {
        id: "yesterday-op",
        budget_id: BUDGET_ID,
        timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        description: "yesterday's operation",
      },
      {
        id: "ancient-op",
        budget_id: BUDGET_ID,
        timestamp: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
        description: "ancient operation",
      },
    );
    await writeFile(filePath, JSON.stringify(raw), "utf8");

    const pending = await store.getPendingOperations(BUDGET_ID);
    expect(pending.map((op) => op.id)).toEqual([fresh, "yesterday-op"]);
  });

  it("keeps pending operations with unparseable timestamps", async () => {
    const filePath = join(dataDir, "history", `${BUDGET_ID}.json`);
    await mkdir(join(dataDir, "history"), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        entries: [],
        id_mappings: {},
        pending_operations: [
          {
            id: "bad-ts",
            budget_id: BUDGET_ID,
            timestamp: "not-a-date",
            description: "corrupt timestamp",
          },
        ],
      }),
      "utf8",
    );

    // A malformed marker still warns about an unreconciled write.
    const pending = await store.getPendingOperations(BUDGET_ID);
    expect(pending.map((op) => op.id)).toEqual(["bad-ts"]);
  });

  it("generates distinct pending ids in the same millisecond", async () => {
    const first = await store.markPending(BUDGET_ID, "op one");
    const second = await store.markPending(BUDGET_ID, "op two");
    expect(first).not.toBe(second);

    await store.clearPending(BUDGET_ID, first);
    const remaining = await store.getPendingOperations(BUDGET_ID);
    expect(remaining.map((op) => op.id)).toEqual([second]);
  });

  it("cleans up aged .tmp and .corrupt-* files but keeps recent ones", async () => {
    const historyDir = join(dataDir, "history");
    await mkdir(historyDir, { recursive: true });

    const oldTmp = join(historyDir, "b.json.123.456.tmp");
    const freshTmp = join(historyDir, "b.json.123.789.tmp");
    const oldCorrupt = join(historyDir, "b.json.corrupt-1-2");
    const freshCorrupt = join(historyDir, "b.json.corrupt-3-4");
    for (const file of [oldTmp, freshTmp, oldCorrupt, freshCorrupt]) {
      await writeFile(file, "{}", "utf8");
    }
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    await utimes(oldTmp, twoHoursAgo, twoHoursAgo);
    await utimes(oldCorrupt, eightDaysAgo, eightDaysAgo);

    // Housekeeping runs lazily on first store use; a fresh store instance
    // triggers it.
    const freshStore = new UndoStore(dataDir);
    await freshStore.getPendingOperations(BUDGET_ID);
    await vi.waitFor(async () => {
      const names = await readdir(historyDir);
      expect(names).not.toContain("b.json.123.456.tmp");
      expect(names).not.toContain("b.json.corrupt-1-2");
    });

    const names = await readdir(historyDir);
    expect(names).toContain("b.json.123.789.tmp");
    expect(names).toContain("b.json.corrupt-3-4");
  });
});
