import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  analyzeTransactions,
  type FlatCategory,
  type TargetTransaction,
} from "../analysis/categorize.js";
import type { AppContext } from "../context.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { extractErrorMessage } from "../ynab/errors.js";
import { formatCurrency, milliunitsToCurrency } from "../ynab/format.js";
import type { NameLookup } from "../ynab/types.js";

const autoCategorizeSchema = z.object({
  budget_id: z
    .string()
    .optional()
    .describe("Budget ID. Omit to use the last-used budget."),
  since_date: z.string().optional().describe("Date in YYYY-MM-DD format."),
  include_unapproved: z.boolean().optional(),
  include_transfers: z
    .boolean()
    .optional()
    .describe(
      "Include internal account transfers in results. Defaults to false since transfers cannot be categorized.",
    ),
  include_approved_uncategorized: z
    .boolean()
    .optional()
    .describe(
      "Include approved transactions that have no category. Defaults to true — set to false to only see unapproved transactions.",
    ),
  approve: z
    .boolean()
    .optional()
    .describe(
      "When true, update_actions will include approved: true so categorization and approval happen in one pass. Defaults to true.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Maximum transactions to analyze. Defaults to 50."),
  history_months: z.number().int().min(1).max(36).optional(),
});

interface TransactionLike {
  id: string;
  date: string;
  amount: number;
  payee_id?: string | null;
  category_id?: string | null;
  memo?: string | null;
  approved: boolean;
  subtransactions?: Array<{
    category_id?: string | null;
    deleted?: boolean;
  }>;
}

function getDefaultSinceDate(): string {
  const date = new Date();
  date.setDate(date.getDate() - 30);
  return date.toISOString().slice(0, 10);
}

function toTarget(
  tx: TransactionLike,
  lookups: NameLookup,
  isUnapprovedReview: boolean,
): TargetTransaction {
  return {
    id: tx.id,
    date: tx.date,
    amount: tx.amount,
    payee_id: tx.payee_id ?? null,
    payee_name: tx.payee_id
      ? (lookups.payeeById.get(tx.payee_id) ?? null)
      : null,
    category_id: isUnapprovedReview ? (tx.category_id ?? null) : null,
    category_name:
      isUnapprovedReview && tx.category_id
        ? (lookups.categoryById.get(tx.category_id)?.name ?? null)
        : null,
    memo: tx.memo ?? null,
    approved: tx.approved,
  };
}

export function registerCategorizationTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "suggest_transaction_categories",
    {
      title: "Suggest Transaction Categories",
      description:
        "Analyze uncategorized (and optionally unapproved) transactions using payee history, " +
        "amount patterns, and scheduled transaction matching. " +
        "Returns categorization suggestions with confidence levels — does NOT apply changes. " +
        "Use the returned update_actions with update_transactions to apply.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: autoCategorizeSchema,
    },
    async (input) => {
      try {
        const resolvedBudgetId = await context.ynabClient.resolveRealBudgetId(
          input.budget_id,
        );
        const limit = input.limit ?? 50;
        const includeUnapproved = input.include_unapproved ?? true;
        const includeTransfers = input.include_transfers ?? false;
        const includeApprovedUncategorized =
          input.include_approved_uncategorized ?? true;
        const shouldApprove = input.approve ?? true;
        const sinceDate = input.since_date ?? getDefaultSinceDate();
        const historyMonths = input.history_months;

        const [
          uncategorizedRaw,
          unapprovedRaw,
          profiles,
          scheduledTransactions,
          categoryGroups,
          lookups,
          settings,
        ] = await Promise.all([
          context.ynabClient.searchTransactions(resolvedBudgetId, {
            type: "uncategorized",
            since_date: sinceDate,
            exclude_transfers: !includeTransfers,
            limit,
            sort: "date_desc",
          }),
          includeUnapproved
            ? context.ynabClient.searchTransactions(resolvedBudgetId, {
                approved: false,
                since_date: sinceDate,
                exclude_transfers: !includeTransfers,
                limit,
                sort: "date_desc",
              })
            : Promise.resolve([]),
          context.payeeProfileAnalyzer.getProfiles(
            resolvedBudgetId,
            historyMonths,
          ),
          context.ynabClient.getScheduledTransactions(resolvedBudgetId),
          context.ynabClient.getCategories(resolvedBudgetId),
          context.ynabClient.getNameLookup(resolvedBudgetId),
          context.ynabClient.getBudgetSettings(resolvedBudgetId),
        ]);

        // Split uncategorized into unapproved-uncategorized and approved-uncategorized
        const unapprovedUncategorized = uncategorizedRaw.filter(
          (tx) => !tx.approved,
        );
        const approvedUncategorized = includeApprovedUncategorized
          ? uncategorizedRaw.filter((tx) => tx.approved)
          : [];

        // Filter unapproved to only those that already have a category (YNAB auto-assigned)
        const seenIds = new Set(uncategorizedRaw.map((tx) => tx.id));
        const unapprovedCategorized = unapprovedRaw.filter(
          (tx) => tx.category_id && !seenIds.has(tx.id),
        );

        const flatCategories: FlatCategory[] = categoryGroups.flatMap((group) =>
          group.categories.map((cat) => ({
            id: cat.id,
            name: cat.name,
            group_id: group.id,
            group_name: group.name,
          })),
        );

        const allCandidates = [
          ...unapprovedUncategorized.map((tx) => ({
            tx,
            unapprovedReview: false,
          })),
          ...approvedUncategorized.map((tx) => ({
            tx,
            unapprovedReview: false,
          })),
          ...unapprovedCategorized.map((tx) => ({
            tx,
            unapprovedReview: true,
          })),
        ];

        const targets: TargetTransaction[] = [];
        const skippedSplits: Array<{
          transaction_id: string;
          reason: string;
        }> = [];

        for (const { tx, unapprovedReview } of allCandidates) {
          const activeSubs =
            (tx as TransactionLike).subtransactions?.filter(
              (s) => !s.deleted,
            ) ?? [];
          if (activeSubs.length > 0) {
            skippedSplits.push({
              transaction_id: tx.id,
              reason:
                "Split transaction — this tool only suggests parent-level category actions, not subtransaction replacements.",
            });
            continue;
          }
          targets.push(toTarget(tx, lookups, unapprovedReview));
        }

        if (targets.length === 0 && skippedSplits.length === 0) {
          return jsonToolResult({
            budget_id: resolvedBudgetId,
            suggestion_count: 0,
            message: "No transactions to categorize.",
          });
        }

        if (targets.length === 0) {
          return jsonToolResult({
            budget_id: resolvedBudgetId,
            suggestion_count: 0,
            skipped_splits: skippedSplits,
            message:
              "All uncategorized transactions are splits whose subtransactions cannot be modified via the API.",
          });
        }

        // Build payee name map for fuzzy matching
        const allPayeeNames = new Map<string, string>();
        for (const [payeeId, payeeName] of lookups.payeeById) {
          allPayeeNames.set(payeeId, payeeName);
        }

        // Run server-side analysis
        const scheduledForAnalysis = scheduledTransactions.map((stx) => ({
          id: stx.id,
          payee_id: stx.payee_id ?? null,
          category_id: stx.category_id ?? null,
          amount: stx.amount,
          frequency: stx.frequency,
        }));

        const suggestions = analyzeTransactions(
          targets,
          profiles,
          scheduledForAnalysis,
          flatCategories,
          allPayeeNames,
        );

        // Build output
        const confidenceSummary = {
          definitive: 0,
          high: 0,
          medium: 0,
          low: 0,
        };
        for (const s of suggestions) {
          confidenceSummary[s.confidence] += 1;
        }

        const categoryGroupById = new Map(
          flatCategories.map((c) => [
            c.id,
            { group_id: c.group_id, group_name: c.group_name },
          ]),
        );

        const formattedSuggestions = suggestions.map((s) => ({
          transaction_id: s.transaction_id,
          date: s.date,
          payee_name: s.payee_name,
          amount: milliunitsToCurrency(s.amount),
          amount_display: formatCurrency(s.amount, settings.currency_format),
          memo: s.memo,
          current_category_id: s.current_category_id,
          current_category_name: s.current_category_name,
          current_category_group_id: s.current_category_id
            ? (categoryGroupById.get(s.current_category_id)?.group_id ?? null)
            : null,
          current_category_group_name: s.current_category_id
            ? (categoryGroupById.get(s.current_category_id)?.group_name ?? null)
            : null,
          suggested_category_id: s.suggested_category_id,
          suggested_category_name: s.suggested_category_name,
          suggested_category_group_id: s.suggested_category_id
            ? (categoryGroupById.get(s.suggested_category_id)?.group_id ?? null)
            : null,
          suggested_category_group_name: s.suggested_category_id
            ? (categoryGroupById.get(s.suggested_category_id)?.group_name ??
              null)
            : null,
          confidence: s.confidence,
          method: s.method,
          reasoning: s.reasoning,
          signals: s.signals,
        }));

        const updateActions = suggestions
          .filter((s) => s.suggested_category_id)
          .map((s) => ({
            transaction_id: s.transaction_id,
            category_id: s.suggested_category_id,
            ...(shouldApprove ? { approved: true } : {}),
          }));

        return jsonToolResult({
          budget_id: resolvedBudgetId,
          suggestion_count: suggestions.length,
          confidence_summary: confidenceSummary,
          suggestions: formattedSuggestions,
          update_actions: updateActions,
          ...(skippedSplits.length > 0 && {
            skipped_splits: skippedSplits,
          }),
        });
      } catch (error) {
        return errorToolResult(
          extractErrorMessage(
            error,
            "Failed to analyze transactions for categorization.",
          ),
        );
      }
    },
  );
}
