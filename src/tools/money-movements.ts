import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { AppContext } from "../context.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { extractErrorMessage } from "../ynab/errors.js";
import { asMilliunits, milliunitsToCurrency } from "../ynab/format.js";

const READY_TO_ASSIGN = "Ready to Assign";

const moneyMovementsSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe("Budget ID. Omit to use the last-used budget."),
  month: z
    .string()
    .optional()
    .describe(
      "Restrict to one month, YYYY-MM-DD format (use first day of month). " +
        "Omit for all months.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe("Maximum movements to return, newest first. Defaults to 50."),
});

export function registerMoneyMovementTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "get_money_movements",
    {
      title: "Get Money Movements",
      description:
        "Audit feed of money moved between categories or to/from Ready to " +
        "Assign, including moves made in the YNAB apps — the only place the " +
        "history behind each category's budgeted amount is visible. Use it to " +
        "explain why a budgeted amount changed, or to see which moves were " +
        "already made this month before proposing new ones. Movements " +
        "performed together as one action share a group with its own note.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: moneyMovementsSchema,
    },
    async (input) => {
      try {
        const resolvedBudgetId = await context.ynabClient.resolveRealBudgetId(
          input.budget_id,
        );
        const limit = input.limit ?? 50;

        const [{ movements, groups }, lookups, settings] = await Promise.all([
          context.ynabClient.getMoneyMovements(resolvedBudgetId, {
            month: input.month,
          }),
          context.ynabClient.getNameLookup(resolvedBudgetId),
          context.ynabClient.getBudgetSettings(resolvedBudgetId),
        ]);

        const groupById = new Map(groups.map((group) => [group.id, group]));

        const categoryName = (id: string | null | undefined): string =>
          id
            ? (lookups.categoryById.get(id)?.name ?? "Unknown Category")
            : READY_TO_ASSIGN;

        // Newest first: moved_at when present, otherwise month
        const sorted = [...movements].sort((a, b) => {
          const ta = a.moved_at ?? a.month ?? "";
          const tb = b.moved_at ?? b.month ?? "";
          return tb.localeCompare(ta);
        });

        const formatted = sorted.slice(0, limit).map((movement) => {
          const group = movement.money_movement_group_id
            ? groupById.get(movement.money_movement_group_id)
            : undefined;
          return {
            id: movement.id,
            month: movement.month ?? null,
            moved_at: movement.moved_at ?? null,
            from_category_id: movement.from_category_id ?? null,
            from_category_name: categoryName(movement.from_category_id),
            to_category_id: movement.to_category_id ?? null,
            to_category_name: categoryName(movement.to_category_id),
            amount: milliunitsToCurrency(asMilliunits(movement.amount)),
            note: movement.note ?? null,
            group_id: movement.money_movement_group_id ?? null,
            group_note: group?.note ?? null,
          };
        });

        return jsonToolResult({
          budget_id: resolvedBudgetId,
          currency: settings.currency_format?.iso_code ?? null,
          month: input.month ?? null,
          count: formatted.length,
          total_matching: movements.length,
          movements: formatted,
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(error, "Failed to get money movements."),
        );
      }
    },
  );
}
