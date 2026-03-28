import { beforeEach, describe, expect, it } from "vitest";

import type { MockAppContext } from "../test-utils.js";
import {
  captureToolHandlers,
  createMockContext,
  createMockUndoEntry,
} from "../test-utils.js";
import { registerUndoTools } from "./undo.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

let ctx: MockAppContext;
let tools: Record<string, ToolHandler>;

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  ctx = createMockContext();
  tools = captureToolHandlers(registerUndoTools, ctx) as Record<
    string,
    ToolHandler
  >;
});

describe("list_undo_history", () => {
  it("resolves the default budget before listing history", async () => {
    ctx.undoEngine.listHistory.mockResolvedValue([createMockUndoEntry()]);

    const result = parseResult(
      await tools.list_undo_history({
        session_id: "session-1",
        include_all_sessions: false,
        limit: 20,
        include_undone: false,
      }),
    );

    expect(ctx.ynabClient.resolveRealBudgetId).toHaveBeenCalledWith(undefined);
    expect(ctx.undoEngine.listHistory).toHaveBeenCalledWith(
      "budget-1",
      "session-1",
      20,
      false,
      false,
    );
    expect(result.budget_id).toBe("budget-1");
    expect(result.session_id).toBe("session-1");
    expect(result.count).toBe(1);
  });

  it("supports listing across all sessions", async () => {
    ctx.undoEngine.listHistory.mockResolvedValue([
      createMockUndoEntry({ session_id: "session-a" }),
      createMockUndoEntry({
        id: "budget-1::2::xyz",
        session_id: "session-b",
      }),
    ]);

    parseResult(
      await tools.list_undo_history({
        session_id: "session-a",
        include_all_sessions: true,
        limit: 20,
        include_undone: true,
      }),
    );

    expect(ctx.undoEngine.listHistory).toHaveBeenCalledWith(
      "budget-1",
      "session-a",
      20,
      true,
      true,
    );
  });
});

describe("undo_operations", () => {
  it("delegates entries and force to the undo engine", async () => {
    ctx.undoEngine.undoOperations.mockResolvedValue({
      results: [{ entry_id: "budget-1::1::abc", status: "undone" }],
      summary: { requested: 1, undone: 1, conflicts: 0, skipped: 0, errors: 0 },
    });

    const result = parseResult(
      await tools.undo_operations({
        session_id: "session-1",
        undo_history_ids: ["budget-1::1::abc"],
        force: true,
      }),
    );

    expect(ctx.undoEngine.undoOperations).toHaveBeenCalledWith(
      ["budget-1::1::abc"],
      "session-1",
      true,
    );
    expect(result.summary.undone).toBe(1);
  });

  it("defaults to shared session when not provided", async () => {
    ctx.undoEngine.undoOperations.mockResolvedValue({
      results: [],
      summary: { undone: 0, conflicts: 0, skipped: 0, errors: 0 },
    });

    parseResult(
      await tools.undo_operations({
        undo_history_ids: ["budget-1::1::abc"],
      }),
    );

    expect(ctx.undoEngine.undoOperations).toHaveBeenCalledWith(
      ["budget-1::1::abc"],
      "shared",
      false,
    );
  });
});
