import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  analyzeTransactions,
  type CategorizationSuggestion,
  type FlatCategory,
  type TargetTransaction,
} from "../analysis/categorize.js";
import type { AppContext } from "../context.js";
import { SamplingNotAvailableError } from "../sampling/client.js";
import { errorToolResult, jsonToolResult } from "../shared/mcp.js";
import { formatCurrency, milliunitsToCurrency } from "../ynab/format.js";

interface LlmCategorizationResult {
  transaction_id: string;
  category_id: string;
  confidence: string;
  reasoning: string;
}

interface RebalanceSuggestion {
  from_category_id: string;
  to_category_id: string;
  amount: number;
  reasoning: string;
}

const autoCategorizeSchema = z.object({
  budget_id: z.string().optional(),
  since_date: z.string().optional(),
  include_unapproved: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  history_months: z.number().int().min(1).max(36).optional(),
});

const coverOverspendingSchema = z.object({
  budget_id: z.string().optional(),
  month: z.string().optional(),
});

export function registerSmartTools(
  server: McpServer,
  context: AppContext,
): void {
  server.registerTool(
    "suggest_transaction_categories",
    {
      title: "Suggest Transaction Categories",
      description:
        "Analyze uncategorized (and optionally unapproved) transactions using payee history, " +
        "amount patterns, scheduled transaction matching, and LLM sampling for ambiguous cases. " +
        "Returns categorization suggestions with confidence levels — does NOT apply changes. " +
        "Use the returned update_actions with update_transactions to apply.",
      annotations: {
        readOnlyHint: true,
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
        const sinceDate = input.since_date ?? getDefaultSinceDate();
        const historyMonths = input.history_months;

        // Fetch all needed data in parallel
        const [
          uncategorized,
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
            limit,
            sort: "date_desc",
          }),
          includeUnapproved
            ? context.ynabClient.searchTransactions(resolvedBudgetId, {
                approved: false,
                since_date: sinceDate,
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

        // Filter unapproved to only those that already have a category (YNAB auto-assigned)
        const unapprovedCategorized = unapprovedRaw.filter(
          (tx) => tx.category_id && !uncategorized.some((u) => u.id === tx.id),
        );

        const flatCategories: FlatCategory[] = categoryGroups.flatMap((group) =>
          group.categories.map((cat) => ({
            id: cat.id,
            name: cat.name,
            group_name: group.name,
          })),
        );

        // Build target transactions
        const targets: TargetTransaction[] = [
          ...uncategorized.map((tx) => toTarget(tx, lookups, false)),
          ...unapprovedCategorized.map((tx) => toTarget(tx, lookups, true)),
        ];

        if (targets.length === 0) {
          return jsonToolResult({
            budget_id: resolvedBudgetId,
            suggestion_count: 0,
            message: "No transactions to categorize.",
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

        let suggestions = analyzeTransactions(
          targets,
          profiles,
          scheduledForAnalysis,
          flatCategories,
          allPayeeNames,
        );

        // LLM sampling for medium/low confidence items
        const needsLlm = suggestions.filter((s) => s.needs_llm_review);
        if (needsLlm.length > 0 && context.samplingClient.isAvailable()) {
          suggestions = await enhanceWithSampling(
            context,
            suggestions,
            needsLlm,
            flatCategories,
            settings.currency_format,
          );
        }

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

        const formattedSuggestions = suggestions.map((s) => ({
          transaction_id: s.transaction_id,
          date: s.date,
          payee_name: s.payee_name,
          amount: milliunitsToCurrency(s.amount),
          amount_display: formatCurrency(s.amount, settings.currency_format),
          memo: s.memo,
          current_category_id: s.current_category_id,
          current_category_name: s.current_category_name,
          suggested_category_id: s.suggested_category_id,
          suggested_category_name: s.suggested_category_name,
          confidence: s.confidence,
          method: s.method,
          reasoning: s.reasoning,
          signals: s.signals,
        }));

        // Pre-build update actions for the client LLM
        const updateActions = suggestions
          .filter((s) => s.suggested_category_id)
          .map((s) => ({
            transaction_id: s.transaction_id,
            category_id: s.suggested_category_id,
          }));

        return jsonToolResult({
          budget_id: resolvedBudgetId,
          suggestion_count: suggestions.length,
          confidence_summary: confidenceSummary,
          suggestions: formattedSuggestions,
          update_actions: updateActions,
        });
      } catch (error) {
        return errorToolResult(
          error instanceof Error
            ? error.message
            : "Failed to analyze transactions for categorization.",
        );
      }
    },
  );

  server.registerTool(
    "suggest_overspending_coverage",
    {
      title: "Suggest Overspending Coverage",
      description:
        "Analyze budget categories to identify overspending and suggest rebalancing moves. " +
        "Uses LLM sampling to suggest which surplus categories to pull from. " +
        "Returns suggestions — does NOT apply changes. " +
        "Use the returned set_budget_actions with set_category_budgets to apply.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: coverOverspendingSchema,
    },
    async (input) => {
      try {
        const resolvedBudgetId = await context.ynabClient.resolveRealBudgetId(
          input.budget_id,
        );
        const month = input.month ?? "current";

        const [categoryGroups, settings] = await Promise.all([
          context.ynabClient.getCategories(resolvedBudgetId, { month }),
          context.ynabClient.getBudgetSettings(resolvedBudgetId),
        ]);

        const overspent: Array<{
          id: string;
          name: string;
          group_name: string;
          balance: number;
          balance_display: string;
          budgeted: number;
          activity: number;
          goal_type: string | null;
        }> = [];

        const surplus: Array<{
          id: string;
          name: string;
          group_name: string;
          balance: number;
          balance_display: string;
          budgeted: number;
          goal_type: string | null;
          goal_target: number | null;
          goal_percentage_complete: number | null;
        }> = [];

        for (const group of categoryGroups) {
          for (const cat of group.categories) {
            if (cat.hidden || cat.deleted) continue;

            if (cat.balance < 0) {
              overspent.push({
                id: cat.id,
                name: cat.name,
                group_name: group.name,
                balance: milliunitsToCurrency(cat.balance),
                balance_display: formatCurrency(
                  cat.balance,
                  settings.currency_format,
                ),
                budgeted: milliunitsToCurrency(cat.budgeted),
                activity: milliunitsToCurrency(cat.activity),
                goal_type: cat.goal_type ?? null,
              });
            } else if (cat.balance > 0) {
              surplus.push({
                id: cat.id,
                name: cat.name,
                group_name: group.name,
                balance: milliunitsToCurrency(cat.balance),
                balance_display: formatCurrency(
                  cat.balance,
                  settings.currency_format,
                ),
                budgeted: milliunitsToCurrency(cat.budgeted),
                goal_type: cat.goal_type ?? null,
                goal_target: cat.goal_target
                  ? milliunitsToCurrency(cat.goal_target)
                  : null,
                goal_percentage_complete: cat.goal_percentage_complete ?? null,
              });
            }
          }
        }

        if (overspent.length === 0) {
          return jsonToolResult({
            budget_id: resolvedBudgetId,
            month,
            message: "No overspent categories found.",
            overspent_count: 0,
          });
        }

        if (!context.samplingClient.isAvailable()) {
          const deterministicResult = await buildDeterministicRebalance(
            context,
            resolvedBudgetId,
            month,
            overspent,
            surplus,
            settings,
          );
          return jsonToolResult(deterministicResult);
        }

        let suggestions: RebalanceSuggestion[];
        try {
          suggestions = await context.samplingClient.createJsonMessage<
            RebalanceSuggestion[]
          >({
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: buildRebalancePrompt(overspent, surplus),
                },
              },
            ],
            systemPrompt: REBALANCE_SYSTEM_PROMPT,
            maxTokens: 4096,
            temperature: 0.2,
            includeContext: "none",
          });
        } catch (error) {
          if (error instanceof SamplingNotAvailableError) {
            throw error;
          }
          return errorToolResult(
            `Failed to get rebalancing suggestions from LLM: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          );
        }

        if (!Array.isArray(suggestions)) {
          return errorToolResult(
            "LLM returned an invalid response format. Expected a JSON array.",
          );
        }

        // Validate suggestions
        const surplusById = new Map(surplus.map((s) => [s.id, s]));
        const overspentIds = new Set(overspent.map((o) => o.id));
        const remainingBalance = new Map(surplus.map((s) => [s.id, s.balance]));

        const validSuggestions: RebalanceSuggestion[] = [];
        const skippedSuggestions: Array<{
          suggestion: RebalanceSuggestion;
          reason: string;
        }> = [];

        for (const suggestion of suggestions) {
          if (!surplusById.has(suggestion.from_category_id)) {
            skippedSuggestions.push({
              suggestion,
              reason: "Source category not found or has no surplus.",
            });
            continue;
          }

          if (!overspentIds.has(suggestion.to_category_id)) {
            skippedSuggestions.push({
              suggestion,
              reason: "Destination category is not overspent.",
            });
            continue;
          }

          if (suggestion.amount <= 0) {
            skippedSuggestions.push({
              suggestion,
              reason: "Amount must be positive.",
            });
            continue;
          }

          const available =
            remainingBalance.get(suggestion.from_category_id) ?? 0;
          if (suggestion.amount > available) {
            skippedSuggestions.push({
              suggestion,
              reason: `Amount ${suggestion.amount} exceeds available balance ${available}.`,
            });
            continue;
          }

          remainingBalance.set(
            suggestion.from_category_id,
            available - suggestion.amount,
          );
          validSuggestions.push(suggestion);
        }

        const formattedSuggestions = validSuggestions.map((s) => ({
          ...s,
          from_category_name: surplusById.get(s.from_category_id)?.name ?? null,
          to_category_name:
            overspent.find((o) => o.id === s.to_category_id)?.name ?? null,
          amount_display: formatCurrency(
            Math.round(s.amount * 1000),
            settings.currency_format,
          ),
        }));

        // Pre-build set_budget_actions for the client LLM
        // Each move requires adjusting both source and destination budgets
        const resolvedMonth = month === "current" ? getCurrentMonth() : month;

        // Fetch current budgeted values for involved categories
        const involvedCategoryIds = new Set<string>();
        for (const s of validSuggestions) {
          involvedCategoryIds.add(s.from_category_id);
          involvedCategoryIds.add(s.to_category_id);
        }

        const currentBudgets = await Promise.all(
          [...involvedCategoryIds].map(async (catId) => ({
            id: catId,
            category: await context.ynabClient.getMonthCategoryById(
              resolvedBudgetId,
              resolvedMonth,
              catId,
            ),
          })),
        );

        const budgetAdjustments = new Map<
          string,
          { currentBudgeted: number; delta: number }
        >();

        for (const { id, category } of currentBudgets) {
          if (category) {
            budgetAdjustments.set(id, {
              currentBudgeted: category.budgeted,
              delta: 0,
            });
          }
        }

        for (const suggestion of validSuggestions) {
          const amountMilliunits = Math.round(suggestion.amount * 1000);
          const from = budgetAdjustments.get(suggestion.from_category_id);
          const to = budgetAdjustments.get(suggestion.to_category_id);
          if (from) from.delta -= amountMilliunits;
          if (to) to.delta += amountMilliunits;
        }

        const setBudgetActions = [...budgetAdjustments.entries()]
          .filter(([, adj]) => adj.delta !== 0)
          .map(([catId, adj]) => ({
            category_id: catId,
            month: resolvedMonth,
            budgeted: milliunitsToCurrency(adj.currentBudgeted + adj.delta),
          }));

        return jsonToolResult({
          budget_id: resolvedBudgetId,
          month: resolvedMonth,
          suggestion_count: validSuggestions.length,
          skipped_count: skippedSuggestions.length,
          suggestions: formattedSuggestions,
          skipped: skippedSuggestions,
          set_budget_actions: setBudgetActions,
        });
      } catch (error) {
        return errorToolResult(
          error instanceof Error
            ? error.message
            : "Failed to analyze overspending.",
        );
      }
    },
  );
}

// --- Helpers ---

function getDefaultSinceDate(): string {
  const date = new Date();
  date.setDate(date.getDate() - 30);
  return date.toISOString().slice(0, 10);
}

function getCurrentMonth(): string {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

interface TransactionLike {
  id: string;
  date: string;
  amount: number;
  payee_id?: string | null;
  category_id?: string | null;
  memo?: string | null;
  approved: boolean;
}

function toTarget(
  tx: TransactionLike,
  lookups: {
    payeeById: Map<string, string>;
    categoryById: Map<string, string>;
  },
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
        ? (lookups.categoryById.get(tx.category_id) ?? null)
        : null,
    memo: tx.memo ?? null,
    approved: tx.approved,
  };
}

async function buildDeterministicRebalance(
  context: AppContext,
  budgetId: string,
  month: string,
  overspent: Array<{
    id: string;
    name: string;
    group_name: string;
    balance: number;
    budgeted: number;
    activity: number;
    goal_type: string | null;
  }>,
  surplus: Array<{
    id: string;
    name: string;
    group_name: string;
    balance: number;
    budgeted: number;
    goal_type: string | null;
    goal_target: number | null;
    goal_percentage_complete: number | null;
  }>,
  settings: { currency_format: Parameters<typeof formatCurrency>[1] },
) {
  const resolvedMonth = month === "current" ? getCurrentMonth() : month;

  const sortedOverspent = [...overspent].sort((a, b) => a.balance - b.balance);
  const sortedSurplus = [...surplus].sort((a, b) => b.balance - a.balance);
  const remainingBalance = new Map(sortedSurplus.map((s) => [s.id, s.balance]));

  const suggestions: Array<{
    from_category_id: string;
    from_category_name: string;
    to_category_id: string;
    to_category_name: string;
    amount: number;
    amount_display: string;
    reasoning: string;
  }> = [];

  for (const category of sortedOverspent) {
    let deficit = Math.abs(category.balance);

    for (const source of sortedSurplus) {
      if (deficit <= 0) break;
      const available = remainingBalance.get(source.id) ?? 0;
      if (available <= 0) continue;

      const moveAmount = Math.min(deficit, available);
      remainingBalance.set(source.id, available - moveAmount);
      deficit -= moveAmount;

      suggestions.push({
        from_category_id: source.id,
        from_category_name: source.name,
        to_category_id: category.id,
        to_category_name: category.name,
        amount: moveAmount,
        amount_display: formatCurrency(
          Math.round(moveAmount * 1000),
          settings.currency_format,
        ),
        reasoning: `Cover ${category.name} deficit from largest available surplus.`,
      });
    }
  }

  const involvedCategoryIds = new Set<string>();
  for (const s of suggestions) {
    involvedCategoryIds.add(s.from_category_id);
    involvedCategoryIds.add(s.to_category_id);
  }

  const currentBudgets = await Promise.all(
    [...involvedCategoryIds].map(async (catId) => ({
      id: catId,
      category: await context.ynabClient.getMonthCategoryById(
        budgetId,
        resolvedMonth,
        catId,
      ),
    })),
  );

  const budgetAdjustments = new Map<
    string,
    { currentBudgeted: number; delta: number }
  >();

  for (const { id, category } of currentBudgets) {
    if (category) {
      budgetAdjustments.set(id, {
        currentBudgeted: category.budgeted,
        delta: 0,
      });
    }
  }

  for (const suggestion of suggestions) {
    const amountMilliunits = Math.round(suggestion.amount * 1000);
    const from = budgetAdjustments.get(suggestion.from_category_id);
    const to = budgetAdjustments.get(suggestion.to_category_id);
    if (from) from.delta -= amountMilliunits;
    if (to) to.delta += amountMilliunits;
  }

  const setBudgetActions = [...budgetAdjustments.entries()]
    .filter(([, adj]) => adj.delta !== 0)
    .map(([catId, adj]) => ({
      category_id: catId,
      month: resolvedMonth,
      budgeted: milliunitsToCurrency(adj.currentBudgeted + adj.delta),
    }));

  return {
    budget_id: budgetId,
    month: resolvedMonth,
    sampling_available: false,
    suggestion_count: suggestions.length,
    suggestions,
    set_budget_actions: setBudgetActions,
  };
}

async function enhanceWithSampling(
  context: AppContext,
  allSuggestions: CategorizationSuggestion[],
  needsLlm: CategorizationSuggestion[],
  categories: FlatCategory[],
  currencyFormat: unknown,
): Promise<CategorizationSuggestion[]> {
  try {
    const transactionsForLlm = needsLlm.map((s) => ({
      transaction_id: s.transaction_id,
      date: s.date,
      payee_name: s.payee_name,
      amount_display: formatCurrency(
        s.amount,
        currencyFormat as Parameters<typeof formatCurrency>[1],
      ),
      memo: s.memo,
      current_suggestion: s.suggested_category_name ?? "none",
      current_confidence: s.confidence,
      signals_summary: buildSignalsSummary(s),
    }));

    const llmResults = await context.samplingClient.createJsonMessage<
      LlmCategorizationResult[]
    >({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: buildSamplingPrompt(categories, transactionsForLlm),
          },
        },
      ],
      systemPrompt: CATEGORIZATION_SYSTEM_PROMPT,
      maxTokens: 4096,
      temperature: 0.1,
      includeContext: "none",
    });

    if (!Array.isArray(llmResults)) return allSuggestions;

    const validCategoryIds = new Set(categories.map((c) => c.id));
    const llmById = new Map<string, LlmCategorizationResult>();
    for (const r of llmResults) {
      if (validCategoryIds.has(r.category_id)) {
        llmById.set(r.transaction_id, r);
      }
    }

    return allSuggestions.map((s) => {
      const llm = llmById.get(s.transaction_id);
      if (!llm || !s.needs_llm_review) return s;

      const categoryName =
        categories.find((c) => c.id === llm.category_id)?.name ?? null;

      return {
        ...s,
        suggested_category_id: llm.category_id,
        suggested_category_name: categoryName,
        confidence: llm.confidence === "high" ? "high" : s.confidence,
        method: `${s.method}+llm`,
        reasoning: llm.reasoning,
        needs_llm_review: false,
      };
    });
  } catch (error) {
    if (error instanceof SamplingNotAvailableError) throw error;
    // If sampling fails, return original suggestions unchanged
    return allSuggestions;
  }
}

function buildSignalsSummary(s: CategorizationSuggestion): string {
  const parts: string[] = [];

  if (s.signals.payee_history) {
    const entries = Object.entries(s.signals.payee_history)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([cat, count]) => `${cat}: ${count}x`);
    parts.push(`Payee history: ${entries.join(", ")}`);
  }

  if (s.signals.amount_pattern) {
    parts.push(
      `Amount pattern: typical=${s.signals.amount_pattern.typical_category_name ?? "unknown"}`,
    );
  }

  if (s.signals.scheduled_match) {
    parts.push(
      `Scheduled match: ${s.signals.scheduled_match.category_name ?? s.signals.scheduled_match.category_id} (${s.signals.scheduled_match.frequency})`,
    );
  }

  if (s.signals.ynab_existing) {
    parts.push(
      `YNAB auto-assigned: ${s.signals.ynab_existing.category_name ?? s.signals.ynab_existing.category_id}`,
    );
  }

  if (s.signals.similar_payees) {
    const sim = s.signals.similar_payees[0];
    parts.push(
      `Similar payee: "${sim.payee_name}" → ${sim.dominant_category_name ?? "unknown"}`,
    );
  }

  return parts.join(" | ") || "No signals";
}

function buildSamplingPrompt(
  categories: FlatCategory[],
  transactions: Array<{
    transaction_id: string;
    date: string;
    payee_name: string | null;
    amount_display: string;
    memo: string | null;
    current_suggestion: string;
    current_confidence: string;
    signals_summary: string;
  }>,
): string {
  return [
    "## Available Categories",
    JSON.stringify(
      categories.map((c) => ({ id: c.id, name: c.name, group: c.group_name })),
      null,
      2,
    ),
    "",
    "## Transactions Needing Review",
    "Each transaction includes pre-computed analysis signals. Use these signals to make your decision.",
    JSON.stringify(transactions, null, 2),
    "",
    "Categorize each transaction, considering the provided signals.",
  ].join("\n");
}

function buildRebalancePrompt(
  overspent: Array<{
    id: string;
    name: string;
    group_name: string;
    balance: number;
    balance_display: string;
    goal_type: string | null;
  }>,
  surplus: Array<{
    id: string;
    name: string;
    group_name: string;
    balance: number;
    balance_display: string;
    goal_type: string | null;
    goal_target: number | null;
    goal_percentage_complete: number | null;
  }>,
): string {
  return [
    "## Overspent Categories",
    JSON.stringify(overspent, null, 2),
    "",
    "## Surplus Categories",
    JSON.stringify(surplus, null, 2),
    "",
    "Suggest budget moves to cover overspending.",
  ].join("\n");
}

const CATEGORIZATION_SYSTEM_PROMPT = `You are a YNAB transaction categorizer. You are given transactions that need review, along with pre-computed analysis signals (payee history, amount patterns, scheduled matches, etc.).

Use the signals to make informed decisions. When signals conflict, weigh them:
1. Scheduled transaction matches are very strong signals
2. Payee history frequency is strong (higher % = more reliable)
3. Amount patterns help disambiguate when a payee has multiple categories
4. YNAB auto-assignments are a moderate signal but can be wrong
5. Similar payee matches are weak but useful for new payees

Respond ONLY with a JSON array. Each element must have:
- "transaction_id": the transaction's ID
- "category_id": the chosen category ID (must be from the provided list)
- "confidence": "high", "medium", or "low"
- "reasoning": brief explanation (max 30 words) referencing which signals you relied on

Rules:
- Never invent category IDs; only use IDs from the provided list.
- Return valid JSON only, no markdown fences or extra text.`;

const REBALANCE_SYSTEM_PROMPT = `You are a YNAB budget advisor. Given overspent and surplus categories for a month, suggest budget moves to cover overspending.

Respond ONLY with a JSON array. Each element must have:
- "from_category_id": source category ID (must have surplus)
- "to_category_id": destination category ID (must be overspent)
- "amount": amount to move (positive number in the budget's currency units, NOT milliunits)
- "reasoning": brief explanation (max 20 words)

Rules:
- Never move more than a category's available balance.
- Prioritize covering essential categories (rent, utilities, groceries) first.
- Prefer taking from categories with the largest surplus relative to their goal.
- Minimize the number of moves.
- Only move exactly enough to cover each overspent category's deficit.
- Return valid JSON only, no markdown fences or extra text.`;
