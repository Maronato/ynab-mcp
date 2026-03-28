import { beforeEach, describe, expect, it } from "vitest";
import type { MockAppContext } from "../test-utils.js";
import { captureToolHandlers, createMockContext } from "../test-utils.js";
import { registerTargetTools } from "./targets.js";

type ToolHandler = (input: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  isError?: boolean;
}>;

let ctx: MockAppContext;
let handler: ToolHandler;

function parseResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function makeCategoryResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "cat-1",
    name: "Groceries",
    goal_type: null as string | null,
    goal_target: null as number | null,
    goal_target_date: null as string | null,
    hidden: false,
    deleted: false,
    budgeted: 500000,
    activity: -300000,
    balance: 200000,
    category_group_id: "group-1",
    ...overrides,
  };
}

beforeEach(() => {
  ctx = createMockContext();
  const tools = captureToolHandlers(registerTargetTools, ctx);
  handler = tools.set_category_targets;
});

describe("set_category_targets", () => {
  describe("setting a target", () => {
    it("sets goal_target and goal_target_date via updateCategory", async () => {
      const before = makeCategoryResponse({
        id: "cat-1",
        name: "Groceries",
        goal_type: null,
        goal_target: null,
        goal_target_date: null,
      });
      const after = makeCategoryResponse({
        id: "cat-1",
        name: "Groceries",
        goal_type: "TB",
        goal_target: 500000, // $500 in milliunits
        goal_target_date: "2026-12-01",
      });

      ctx.ynabClient.getCategoryById.mockResolvedValue(before);
      ctx.ynabClient.updateCategory.mockResolvedValue(after);
      ctx.undoEngine.recordEntries.mockResolvedValue([
        { id: "undo-1", budget_id: "budget-1" },
      ]);

      const result = parseResult(
        await handler({
          targets: [
            {
              category_id: "cat-1",
              goal_target: 500.0,
              goal_target_date: "2026-12-01",
            },
          ],
        }),
      );

      expect(result.results).toHaveLength(1);
      const item = result.results[0];
      expect(item.status).toBe("updated");
      expect(item.category_id).toBe("cat-1");
      expect(item.category_name).toBe("Groceries");

      // Before state
      expect(item.before.goal_type).toBeNull();
      expect(item.before.goal_target).toBeNull();
      expect(item.before.goal_target_date).toBeNull();

      // After state
      expect(item.after.goal_type).toBe("TB");
      expect(item.after.goal_target).toBe(500);
      expect(item.after.goal_target_date).toBe("2026-12-01");
    });

    it("calls updateCategory with the correct milliunits amount", async () => {
      const before = makeCategoryResponse();
      const after = makeCategoryResponse({
        goal_target: 250000,
        goal_target_date: "2026-06-01",
      });

      ctx.ynabClient.getCategoryById.mockResolvedValue(before);
      ctx.ynabClient.updateCategory.mockResolvedValue(after);

      await handler({
        targets: [
          {
            category_id: "cat-1",
            goal_target: 250.0,
            goal_target_date: "2026-06-01",
          },
        ],
      });

      // Verify the updateCategory call received milliunits (250 * 1000 = 250000)
      expect(ctx.ynabClient.updateCategory).toHaveBeenCalledWith(
        expect.any(String),
        "cat-1",
        expect.objectContaining({
          goal_target: 250000,
          goal_target_date: "2026-06-01",
        }),
      );
    });
  });

  describe("clearing a target (null)", () => {
    it("passes null goal_target when attempting to clear", async () => {
      const before = makeCategoryResponse({
        goal_type: "TB",
        goal_target: 500000,
        goal_target_date: "2026-12-01",
      });
      const after = makeCategoryResponse({
        goal_type: null,
        goal_target: null,
        goal_target_date: null,
      });

      ctx.ynabClient.getCategoryById.mockResolvedValue(before);
      ctx.ynabClient.updateCategory.mockResolvedValue(after);

      const result = parseResult(
        await handler({
          targets: [
            {
              category_id: "cat-1",
              goal_target: null,
              goal_target_date: null,
            },
          ],
        }),
      );

      expect(ctx.ynabClient.updateCategory).toHaveBeenCalledWith(
        expect.any(String),
        "cat-1",
        expect.objectContaining({
          goal_target: null,
          goal_target_date: null,
        }),
      );

      const item = result.results[0];
      expect(item.status).toBe("updated");
      expect(item.before.goal_target).toBe(500);
      expect(item.after.goal_target).toBeNull();
    });
  });

  describe("before/after state tracking", () => {
    it("returns before and after states showing the transition", async () => {
      const before = makeCategoryResponse({
        goal_type: "TB",
        goal_target: 300000,
        goal_target_date: "2026-06-01",
      });
      const after = makeCategoryResponse({
        goal_type: "TB",
        goal_target: 750000,
        goal_target_date: "2026-12-01",
      });

      ctx.ynabClient.getCategoryById.mockResolvedValue(before);
      ctx.ynabClient.updateCategory.mockResolvedValue(after);

      const result = parseResult(
        await handler({
          targets: [
            {
              category_id: "cat-1",
              goal_target: 750.0,
              goal_target_date: "2026-12-01",
            },
          ],
        }),
      );

      const item = result.results[0];
      expect(item.before.goal_target).toBe(300);
      expect(item.before.goal_target_date).toBe("2026-06-01");
      expect(item.after.goal_target).toBe(750);
      expect(item.after.goal_target_date).toBe("2026-12-01");
    });
  });

  describe("undo entries", () => {
    it("records undo entries with previous state", async () => {
      const before = makeCategoryResponse({
        goal_target: 200000,
        goal_target_date: "2026-03-01",
      });
      const after = makeCategoryResponse({
        goal_target: 500000,
        goal_target_date: "2026-12-01",
      });

      ctx.ynabClient.getCategoryById.mockResolvedValue(before);
      ctx.ynabClient.updateCategory.mockResolvedValue(after);
      ctx.undoEngine.recordEntries.mockResolvedValue([
        { id: "undo-abc", budget_id: "budget-1" },
      ]);

      const result = parseResult(
        await handler({
          targets: [
            {
              category_id: "cat-1",
              goal_target: 500.0,
              goal_target_date: "2026-12-01",
            },
          ],
        }),
      );

      expect(result.undo_history_ids).toHaveLength(1);
      expect(result.undo_history_ids[0]).toBe("undo-abc");

      // Verify recordEntries was called with restore_state containing the old values
      expect(ctx.undoEngine.recordEntries).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([
          expect.objectContaining({
            operation: "set_category_target",
            undo_action: expect.objectContaining({
              type: "update",
              entity_type: "category_target",
              entity_id: "cat-1",
              restore_state: expect.objectContaining({
                category_id: "cat-1",
                goal_target: 200000,
                goal_target_date: "2026-03-01",
              }),
              expected_state: expect.objectContaining({
                category_id: "cat-1",
                goal_target: 500000,
                goal_target_date: "2026-12-01",
              }),
            }),
          }),
        ]),
        undefined,
      );
    });

    it("does not record undo entries for failed updates", async () => {
      ctx.ynabClient.getCategoryById.mockResolvedValue(null);
      ctx.undoEngine.recordEntries.mockResolvedValue([]);

      const result = parseResult(
        await handler({
          targets: [{ category_id: "cat-missing", goal_target: 100.0 }],
        }),
      );

      expect(result.results[0].status).toBe("error");
      // recordUndoAndGetIds early-returns [] for empty entry lists,
      // so recordEntries should NOT be called at all.
      expect(ctx.undoEngine.recordEntries).not.toHaveBeenCalled();
      expect(result.undo_history_ids).toHaveLength(0);
    });
  });

  describe("missing category (error per item)", () => {
    it("returns an error result when category is not found", async () => {
      ctx.ynabClient.getCategoryById.mockResolvedValue(null);

      const result = parseResult(
        await handler({
          targets: [{ category_id: "cat-nonexistent", goal_target: 100.0 }],
        }),
      );

      expect(result.results).toHaveLength(1);
      const item = result.results[0];
      expect(item.status).toBe("error");
      expect(item.category_id).toBe("cat-nonexistent");
      expect(item.message).toContain("not found");
    });

    it("succeeds for valid categories while reporting errors for missing ones", async () => {
      const validBefore = makeCategoryResponse({
        id: "cat-valid",
        name: "Groceries",
      });
      const validAfter = makeCategoryResponse({
        id: "cat-valid",
        name: "Groceries",
        goal_target: 500000,
      });

      ctx.ynabClient.getCategoryById
        .mockResolvedValueOnce(validBefore) // cat-valid
        .mockResolvedValueOnce(null); // cat-missing
      ctx.ynabClient.updateCategory.mockResolvedValue(validAfter);
      ctx.undoEngine.recordEntries.mockResolvedValue([
        { id: "undo-1", budget_id: "budget-1" },
      ]);

      const result = parseResult(
        await handler({
          targets: [
            { category_id: "cat-valid", goal_target: 500.0 },
            { category_id: "cat-missing", goal_target: 200.0 },
          ],
        }),
      );

      expect(result.results).toHaveLength(2);
      expect(result.results[0].status).toBe("updated");
      expect(result.results[0].category_id).toBe("cat-valid");
      expect(result.results[1].status).toBe("error");
      expect(result.results[1].category_id).toBe("cat-missing");
    });
  });

  describe("multiple targets in one call", () => {
    it("processes multiple targets and returns results for each", async () => {
      const cat1Before = makeCategoryResponse({
        id: "cat-1",
        name: "Groceries",
      });
      const cat1After = makeCategoryResponse({
        id: "cat-1",
        name: "Groceries",
        goal_target: 500000,
        goal_target_date: "2026-12-01",
      });
      const cat2Before = makeCategoryResponse({
        id: "cat-2",
        name: "Dining Out",
      });
      const cat2After = makeCategoryResponse({
        id: "cat-2",
        name: "Dining Out",
        goal_target: 200000,
      });

      ctx.ynabClient.getCategoryById
        .mockResolvedValueOnce(cat1Before)
        .mockResolvedValueOnce(cat2Before);
      ctx.ynabClient.updateCategory
        .mockResolvedValueOnce(cat1After)
        .mockResolvedValueOnce(cat2After);
      ctx.undoEngine.recordEntries.mockResolvedValue([
        { id: "undo-1", budget_id: "budget-1" },
        { id: "undo-2", budget_id: "budget-1" },
      ]);

      const result = parseResult(
        await handler({
          targets: [
            {
              category_id: "cat-1",
              goal_target: 500.0,
              goal_target_date: "2026-12-01",
            },
            { category_id: "cat-2", goal_target: 200.0 },
          ],
        }),
      );

      expect(result.results).toHaveLength(2);
      expect(result.results[0].status).toBe("updated");
      expect(result.results[0].after.goal_target).toBe(500);
      expect(result.results[1].status).toBe("updated");
      expect(result.results[1].after.goal_target).toBe(200);
      expect(result.undo_history_ids).toHaveLength(2);
    });
  });

  describe("budget_id resolution", () => {
    it("returns the resolved budget_id in the result", async () => {
      ctx.ynabClient.getCategoryById.mockResolvedValue(null);

      const result = parseResult(
        await handler({
          budget_id: "specific-budget",
          targets: [{ category_id: "cat-1", goal_target: 100.0 }],
        }),
      );

      expect(result.budget_id).toBe("specific-budget");
    });
  });

  describe("updateCategory failure", () => {
    it("returns an error when updateCategory throws", async () => {
      const before = makeCategoryResponse();
      ctx.ynabClient.getCategoryById.mockResolvedValue(before);
      ctx.ynabClient.updateCategory.mockRejectedValue(
        new Error("API rate limit"),
      );

      const result = parseResult(
        await handler({
          targets: [{ category_id: "cat-1", goal_target: 500.0 }],
        }),
      );

      expect(result.results).toHaveLength(1);
      expect(result.results[0].status).toBe("error");
      expect(result.results[0].message).toContain("API rate limit");
    });
  });
});
