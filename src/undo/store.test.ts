import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SESSION_ID } from "../shared/session.js";
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

function isoTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

describe("appendEntries and persistence", () => {
  it("creates history file and entries can be read back", async () => {
    const e = entry("budget-1::1::aaa");
    await store.appendEntries(BUDGET_ID, [e]);

    const result = await store.listEntries(BUDGET_ID, {
      includeAllSessions: true,
      sessionId: "any",
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

    const entries = await store.listEntries(BUDGET_ID, {
      includeAllSessions: true,
      sessionId: "any",
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

    const result = await store.listEntries(BUDGET_ID, {
      includeAllSessions: true,
      sessionId: "any",
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

    const result = await smallStore.listEntries(BUDGET_ID, {
      includeAllSessions: true,
      sessionId: "any",
      limit: 100,
      includeUndone: true,
    });

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe("budget-1::4::e");
  });
});

describe("listEntries", () => {
  it("returns all active entries when includeAllSessions is true", async () => {
    await store.appendEntries(BUDGET_ID, [
      entry("budget-1::1::a", { session_id: "s1" }),
      entry("budget-1::2::b", { session_id: "s2" }),
    ]);

    const result = await store.listEntries(BUDGET_ID, {
      includeAllSessions: true,
      sessionId: "s1",
      limit: 100,
      includeUndone: false,
    });

    expect(result).toHaveLength(2);
  });

  it("filters to matching sessionId by default", async () => {
    await store.appendEntries(BUDGET_ID, [
      entry("budget-1::1::a", { session_id: "s1" }),
      entry("budget-1::2::b", { session_id: "s2" }),
    ]);

    const result = await store.listEntries(BUDGET_ID, {
      sessionId: "s1",
      limit: 100,
      includeUndone: false,
    });

    expect(result).toHaveLength(1);
    expect(result[0].session_id).toBe("s1");
  });

  it("excludes undone entries when includeUndone is false", async () => {
    await store.appendEntries(BUDGET_ID, [
      entry("budget-1::1::a"),
      entry("budget-1::2::b"),
    ]);
    await store.markEntriesUndone(BUDGET_ID, ["budget-1::1::a"]);

    const result = await store.listEntries(BUDGET_ID, {
      includeAllSessions: true,
      sessionId: "any",
      limit: 100,
      includeUndone: false,
    });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("budget-1::2::b");
  });

  it("includes undone entries when includeUndone is true", async () => {
    await store.appendEntries(BUDGET_ID, [entry("budget-1::1::a")]);
    await store.markEntriesUndone(BUDGET_ID, ["budget-1::1::a"]);

    const result = await store.listEntries(BUDGET_ID, {
      includeAllSessions: true,
      sessionId: "any",
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

    const result = await store.listEntries(BUDGET_ID, {
      includeAllSessions: true,
      sessionId: "any",
      limit: 2,
      includeUndone: false,
    });

    expect(result).toHaveLength(2);
  });

  it("returns empty array for a budget with no history", async () => {
    const result = await store.listEntries("nonexistent", {
      includeAllSessions: true,
      sessionId: "any",
      limit: 100,
      includeUndone: false,
    });

    expect(result).toEqual([]);
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

    const all = await store.listEntries(BUDGET_ID, {
      includeAllSessions: true,
      sessionId: "any",
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

    const result = await store.listEntries(BUDGET_ID, {
      includeAllSessions: true,
      sessionId: "any",
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

describe("session cleanup", () => {
  it("purges sessions older than TTL but keeps shared and recent sessions", async () => {
    const nowMs = Date.parse("2024-01-03T00:00:00.000Z");
    const cleanupStore = new UndoStore(dataDir, 200, {
      sessionTtlMs: 24 * 60 * 60 * 1000,
      cleanupIntervalMs: 60 * 60 * 1000,
      now: () => nowMs,
    });

    await cleanupStore.appendEntries(BUDGET_ID, [
      entry("budget-1::1::old", {
        session_id: "session-old",
        timestamp: isoTimestamp(nowMs - 2 * 24 * 60 * 60 * 1000),
      }),
      entry("budget-1::2::shared-old", {
        session_id: DEFAULT_SESSION_ID,
        timestamp: isoTimestamp(nowMs - 3 * 24 * 60 * 60 * 1000),
      }),
      entry("budget-1::3::fresh", {
        session_id: "session-fresh",
        timestamp: isoTimestamp(nowMs - 60 * 60 * 1000),
      }),
    ]);

    const entries = await cleanupStore.listEntries(BUDGET_ID, {
      includeAllSessions: true,
      sessionId: "any",
      limit: 100,
      includeUndone: true,
    });

    expect(entries.find((e) => e.session_id === "session-old")).toBeUndefined();
    expect(
      entries.find((e) => e.session_id === DEFAULT_SESSION_ID),
    ).toBeDefined();
    expect(entries.find((e) => e.session_id === "session-fresh")).toBeDefined();
  });

  it("does not purge within cleanup interval, then purges after interval", async () => {
    let nowMs = 10_000;
    const cleanupStore = new UndoStore(dataDir, 200, {
      sessionTtlMs: 1_000,
      cleanupIntervalMs: 10_000,
      now: () => nowMs,
    });

    await cleanupStore.appendEntries(BUDGET_ID, [
      entry("budget-1::1::s1", {
        session_id: "session-one",
        timestamp: isoTimestamp(nowMs),
      }),
    ]);

    nowMs = 15_000;
    await cleanupStore.appendEntries(BUDGET_ID, [
      entry("budget-1::2::s2", {
        session_id: "session-two",
        timestamp: isoTimestamp(nowMs),
      }),
    ]);

    const beforeCleanup = await cleanupStore.listEntries(BUDGET_ID, {
      includeAllSessions: true,
      sessionId: "any",
      limit: 100,
      includeUndone: true,
    });
    expect(
      beforeCleanup.find((e) => e.session_id === "session-one"),
    ).toBeDefined();

    nowMs = 21_000;
    await cleanupStore.appendEntries(BUDGET_ID, [
      entry("budget-1::3::s3", {
        session_id: "session-three",
        timestamp: isoTimestamp(nowMs),
      }),
    ]);

    const afterCleanup = await cleanupStore.listEntries(BUDGET_ID, {
      includeAllSessions: true,
      sessionId: "any",
      limit: 100,
      includeUndone: true,
    });
    expect(
      afterCleanup.find((e) => e.session_id === "session-one"),
    ).toBeUndefined();
    expect(
      afterCleanup.find((e) => e.session_id === "session-three"),
    ).toBeDefined();
  });

  it("does not purge a session with only undone entries when it is still within TTL", async () => {
    let nowMs = Date.parse("2024-01-03T00:00:00.000Z");
    const cleanupStore = new UndoStore(dataDir, 200, {
      sessionTtlMs: 24 * 60 * 60 * 1000,
      cleanupIntervalMs: 60 * 60 * 1000,
      now: () => nowMs,
    });

    await cleanupStore.appendEntries(BUDGET_ID, [
      entry("budget-1::1::undone", {
        session_id: "session-undone",
        status: "undone",
        timestamp: isoTimestamp(nowMs - 30 * 60 * 1000),
      }),
    ]);

    nowMs += 2 * 60 * 60 * 1000;
    await cleanupStore.appendEntries(BUDGET_ID, [
      entry("budget-1::2::trigger", {
        session_id: "session-trigger",
        timestamp: isoTimestamp(nowMs),
      }),
    ]);

    const entries = await cleanupStore.listEntries(BUDGET_ID, {
      includeAllSessions: true,
      sessionId: "any",
      limit: 100,
      includeUndone: true,
    });
    expect(
      entries.find((e) => e.session_id === "session-undone"),
    ).toBeDefined();
  });

  it("returns early for empty append without writing history files", async () => {
    const cleanupStore = new UndoStore(dataDir);
    await cleanupStore.appendEntries(BUDGET_ID, []);

    const historyDir = join(dataDir, "history");
    await expect(readdir(historyDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes orphaned id mappings when expired sessions are purged", async () => {
    let nowMs = Date.parse("2024-01-03T00:00:00.000Z");
    const cleanupStore = new UndoStore(dataDir, 200, {
      sessionTtlMs: 24 * 60 * 60 * 1000,
      cleanupIntervalMs: 60 * 60 * 1000,
      now: () => nowMs,
    });

    await cleanupStore.appendEntries(BUDGET_ID, [
      entry("budget-1::1::old", {
        session_id: "session-old",
        timestamp: isoTimestamp(nowMs - 2 * 24 * 60 * 60 * 1000),
        undo_action: {
          entity_id: "old-entity",
        },
      }),
      entry("budget-1::2::fresh", {
        session_id: "session-fresh",
        timestamp: isoTimestamp(nowMs - 60 * 60 * 1000),
        undo_action: {
          entity_id: "fresh-entity",
        },
      }),
    ]);

    await cleanupStore.updateIdMappings(BUDGET_ID, "old-entity", "old-target");
    await cleanupStore.updateIdMappings(
      BUDGET_ID,
      "fresh-entity",
      "fresh-target",
    );

    nowMs += 2 * 60 * 60 * 1000;
    await cleanupStore.appendEntries(BUDGET_ID, [
      entry("budget-1::3::trigger", {
        session_id: "session-trigger",
        timestamp: isoTimestamp(nowMs),
      }),
    ]);

    expect(await cleanupStore.resolveMappedId(BUDGET_ID, "old-entity")).toBe(
      "old-entity",
    );
    expect(await cleanupStore.resolveMappedId(BUDGET_ID, "fresh-entity")).toBe(
      "fresh-target",
    );
  });
});

describe("concurrency", () => {
  it("serializes concurrent operations on the same budget", async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      entry(`budget-1::${i}::e`),
    );

    // Append all concurrently
    await Promise.all(entries.map((e) => store.appendEntries(BUDGET_ID, [e])));

    const result = await store.listEntries(BUDGET_ID, {
      includeAllSessions: true,
      sessionId: "any",
      limit: 100,
      includeUndone: true,
    });

    // All 10 entries should be present (no data loss from races)
    expect(result).toHaveLength(10);
  });

  it("serializes concurrent operations across separate store instances", async () => {
    const storeA = new UndoStore(dataDir);
    const storeB = new UndoStore(dataDir);
    const entries = Array.from({ length: 12 }, (_, i) =>
      entry(`budget-1::cross-${i}::e`),
    );

    await Promise.all(
      entries.map((undoEntry, index) =>
        (index % 2 === 0 ? storeA : storeB).appendEntries(BUDGET_ID, [
          undoEntry,
        ]),
      ),
    );

    const result = await store.listEntries(BUDGET_ID, {
      includeAllSessions: true,
      sessionId: "any",
      limit: 100,
      includeUndone: true,
    });

    expect(result).toHaveLength(12);
  });
});

describe("error handling", () => {
  it("returns default empty history for missing file", async () => {
    const result = await store.listEntries("no-such-budget", {
      includeAllSessions: true,
      sessionId: "any",
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

    const result = await store.listEntries(BUDGET_ID, {
      includeAllSessions: true,
      sessionId: "any",
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
