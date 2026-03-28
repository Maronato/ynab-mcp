import type { PayeeProfile } from "./payee-profiles.js";
import { getDominantCategory } from "./payee-profiles.js";

export interface TargetTransaction {
  id: string;
  date: string;
  amount: number;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  category_name: string | null;
  memo: string | null;
  approved: boolean;
}

export interface FlatCategory {
  id: string;
  name: string;
  group_id: string;
  group_name: string;
}

export interface ScheduledTransactionMatch {
  scheduled_transaction_id: string;
  category_id: string;
  category_name: string | null;
  amount: number;
  frequency: string;
}

export interface CategorizationSignals {
  payee_history: Record<string, number> | null;
  payee_history_dominant: string | null;
  payee_history_confidence: number | null;
  scheduled_match: ScheduledTransactionMatch | null;
  ynab_existing: {
    category_id: string;
    category_name: string | null;
  } | null;
  similar_payees: Array<{
    payee_name: string;
    similarity: number;
    dominant_category: string | null;
    dominant_category_name: string | null;
  }> | null;
}

type ConfidenceTier = "definitive" | "high" | "medium" | "low";

export interface CategorizationSuggestion {
  transaction_id: string;
  date: string;
  payee_name: string | null;
  amount: number;
  memo: string | null;
  current_category_id: string | null;
  current_category_name: string | null;
  suggested_category_id: string;
  suggested_category_name: string | null;
  confidence: ConfidenceTier;
  method: string;
  reasoning: string;
  signals: CategorizationSignals;
}

interface ScheduledTxLike {
  id: string;
  payee_id: string | null;
  category_id: string | null;
  amount: number;
  frequency: string;
}

export function analyzeTransactions(
  targets: TargetTransaction[],
  profiles: Map<string, PayeeProfile>,
  scheduledTransactions: ScheduledTxLike[],
  categories: FlatCategory[],
  allPayeeNames: Map<string, string>,
): CategorizationSuggestion[] {
  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));

  return targets.map((tx) =>
    analyzeOne(
      tx,
      profiles,
      scheduledTransactions,
      categoryNameById,
      allPayeeNames,
    ),
  );
}

function analyzeOne(
  tx: TargetTransaction,
  profiles: Map<string, PayeeProfile>,
  scheduledTransactions: ScheduledTxLike[],
  categoryNameById: Map<string, string>,
  allPayeeNames: Map<string, string>,
): CategorizationSuggestion {
  const signals = gatherSignals(
    tx,
    profiles,
    scheduledTransactions,
    categoryNameById,
    allPayeeNames,
  );

  return scoreAndAssign(tx, signals, categoryNameById);
}

function gatherSignals(
  tx: TargetTransaction,
  profiles: Map<string, PayeeProfile>,
  scheduledTransactions: ScheduledTxLike[],
  categoryNameById: Map<string, string>,
  allPayeeNames: Map<string, string>,
): CategorizationSignals {
  // Signal 1: Payee history
  let payeeHistory: Record<string, number> | null = null;
  let payeeHistoryDominant: string | null = null;
  let payeeHistoryConfidence: number | null = null;

  const profile = tx.payee_id ? profiles.get(tx.payee_id) : null;
  if (profile && profile.total_count > 0) {
    payeeHistory = Object.fromEntries(profile.category_counts);
    payeeHistoryDominant = getDominantFromWeighted(profile);
    const dominantCount =
      profile.category_counts.get(payeeHistoryDominant ?? "") ?? 0;
    payeeHistoryConfidence = dominantCount / profile.total_count;
  }

  // Signal 2: Scheduled transaction match
  let scheduledMatch: ScheduledTransactionMatch | null = null;
  if (tx.payee_id) {
    const match = scheduledTransactions.find(
      (stx) =>
        stx.payee_id === tx.payee_id &&
        stx.category_id &&
        isAmountSimilar(tx.amount, stx.amount, 0.2),
    );
    if (match?.category_id) {
      scheduledMatch = {
        scheduled_transaction_id: match.id,
        category_id: match.category_id,
        category_name: categoryNameById.get(match.category_id) ?? null,
        amount: match.amount,
        frequency: match.frequency,
      };
    }
  }

  // Signal 3: YNAB existing (for unapproved auto-categorized)
  let ynabExisting: CategorizationSignals["ynab_existing"] = null;
  if (tx.category_id && !tx.approved) {
    ynabExisting = {
      category_id: tx.category_id,
      category_name:
        tx.category_name ?? categoryNameById.get(tx.category_id) ?? null,
    };
  }

  // Signal 4: Similar payees (only if no direct profile)
  let similarPayees: CategorizationSignals["similar_payees"] = null;
  if (!profile && tx.payee_name) {
    const matches = findSimilarPayees(
      tx.payee_name,
      allPayeeNames,
      profiles,
      3,
    );
    if (matches.length > 0) {
      similarPayees = matches.map((m) => ({
        payee_name: m.profile.payee_name,
        similarity: m.similarity,
        dominant_category: getDominantFromWeighted(m.profile),
        dominant_category_name: (() => {
          const dom = getDominantFromWeighted(m.profile);
          return dom ? (categoryNameById.get(dom) ?? null) : null;
        })(),
      }));
    }
  }

  return {
    payee_history: payeeHistory,
    payee_history_dominant: payeeHistoryDominant,
    payee_history_confidence: payeeHistoryConfidence,
    scheduled_match: scheduledMatch,
    ynab_existing: ynabExisting,
    similar_payees: similarPayees,
  };
}

function scoreAndAssign(
  tx: TargetTransaction,
  signals: CategorizationSignals,
  categoryNameById: Map<string, string>,
): CategorizationSuggestion {
  const base = {
    transaction_id: tx.id,
    date: tx.date,
    payee_name: tx.payee_name,
    amount: tx.amount,
    memo: tx.memo,
    current_category_id: tx.category_id,
    current_category_name: tx.category_name,
    signals,
  };

  // Definitive: strong payee history (>90%, 5+ txs)
  const histConf = signals.payee_history_confidence ?? 0;
  const histDom = signals.payee_history_dominant;
  const histTotal = signals.payee_history
    ? Object.values(signals.payee_history).reduce((s, n) => s + n, 0)
    : 0;

  if (histDom && histConf > 0.9 && histTotal >= 5) {
    return {
      ...base,
      suggested_category_id: histDom,
      suggested_category_name: categoryNameById.get(histDom) ?? null,
      confidence: "definitive",
      method: "payee_history",
      reasoning: `Payee categorized as ${categoryNameById.get(histDom) ?? histDom} ${Math.round(histConf * 100)}% of the time (${histTotal} transactions)`,
    };
  }

  // Scheduled match → at least high
  if (signals.scheduled_match) {
    const sm = signals.scheduled_match;
    // If payee history agrees, it's definitive
    if (histDom && histDom === sm.category_id && histConf > 0.7) {
      return {
        ...base,
        suggested_category_id: sm.category_id,
        suggested_category_name: sm.category_name,
        confidence: "definitive",
        method: "scheduled_match+payee_history",
        reasoning: `Matches scheduled ${sm.frequency} transaction and payee history (${Math.round(histConf * 100)}%)`,
      };
    }
    return {
      ...base,
      suggested_category_id: sm.category_id,
      suggested_category_name: sm.category_name,
      confidence: "high",
      method: "scheduled_match",
      reasoning: `Matches scheduled ${sm.frequency} transaction (${sm.category_name ?? sm.category_id})`,
    };
  }

  // High: strong payee history (>70%)
  if (histDom && histConf > 0.7 && histTotal >= 3) {
    return {
      ...base,
      suggested_category_id: histDom,
      suggested_category_name: categoryNameById.get(histDom) ?? null,
      confidence: "high",
      method: "payee_history",
      reasoning: `Payee categorized as ${categoryNameById.get(histDom) ?? histDom} ${Math.round(histConf * 100)}% of the time (${histTotal} transactions)`,
    };
  }

  // YNAB existing: check before generic medium payee history
  // so we can detect disagreements
  if (signals.ynab_existing) {
    const ye = signals.ynab_existing;
    // If payee history weakly agrees, boost
    if (histDom && histDom === ye.category_id) {
      return {
        ...base,
        suggested_category_id: ye.category_id,
        suggested_category_name: ye.category_name,
        confidence: "medium",
        method: "ynab_auto+payee_history",
        reasoning: `YNAB auto-assigned ${ye.category_name ?? ye.category_id}, weak payee history agrees`,
      };
    }
    // YNAB disagrees with payee history → flag for review
    if (histDom && histDom !== ye.category_id) {
      return {
        ...base,
        suggested_category_id: histDom,
        suggested_category_name: categoryNameById.get(histDom) ?? null,
        confidence: "medium",
        method: "payee_history_vs_ynab",
        reasoning: `YNAB auto-assigned ${ye.category_name ?? ye.category_id} but payee history suggests ${categoryNameById.get(histDom) ?? histDom} (${Math.round((histConf ?? 0) * 100)}%)`,
      };
    }
    // No payee history at all, just YNAB
    return {
      ...base,
      suggested_category_id: ye.category_id,
      suggested_category_name: ye.category_name,
      confidence: "medium",
      method: "ynab_auto",
      reasoning: `YNAB auto-assigned ${ye.category_name ?? ye.category_id}, no payee history to verify`,
    };
  }

  // Medium: payee history exists but weak (40-70%)
  if (histDom && histConf > 0.4 && histTotal >= 2) {
    return {
      ...base,
      suggested_category_id: histDom,
      suggested_category_name: categoryNameById.get(histDom) ?? null,
      confidence: "medium",
      method: "payee_history",
      reasoning: `Payee categorized as ${categoryNameById.get(histDom) ?? histDom} ${Math.round(histConf * 100)}% of the time (${histTotal} transactions, ambiguous)`,
    };
  }

  // Similar payees
  if (signals.similar_payees && signals.similar_payees.length > 0) {
    const best = signals.similar_payees[0];
    if (best.dominant_category && best.similarity >= 0.5) {
      return {
        ...base,
        suggested_category_id: best.dominant_category,
        suggested_category_name: best.dominant_category_name,
        confidence: "medium",
        method: "similar_payee",
        reasoning: `Similar to "${best.payee_name}" which is typically ${best.dominant_category_name ?? best.dominant_category}`,
      };
    }
  }

  // Low: no useful signals
  // Pick most recent category from similar payees if available, else empty
  const fallbackCat = signals.similar_payees?.[0]?.dominant_category ?? histDom;
  if (fallbackCat) {
    return {
      ...base,
      suggested_category_id: fallbackCat,
      suggested_category_name: categoryNameById.get(fallbackCat) ?? null,
      confidence: "low",
      method: "weak_signal",
      reasoning: "Weak signals only — manual review recommended",
    };
  }

  // Truly no signal — cannot suggest, but we still need a suggestion
  // Use the first non-hidden category as a placeholder
  return {
    ...base,
    suggested_category_id: "",
    suggested_category_name: null,
    confidence: "low",
    method: "no_signal",
    reasoning: "No categorization signals available — manual review required",
  };
}

// --- Fuzzy payee name matching ---

export function normalizePayeeName(name: string): string {
  return (
    name
      .toLowerCase()
      // Bank prefixes first (before other patterns eat the tokens)
      .replace(/\b(pos|debit|check card|purchase)\b/g, "")
      // SQ*, TST*, PAYPAL* patterns (the * is not a word char so no \b after)
      .replace(/\b(sq|tst|paypal)\s*\*\s*/gi, "")
      .replace(/\b[a-z]{2}\s+\d{5}(-\d{4})?\b/g, "") // strip state + ZIP codes
      .replace(/[#*]\s*\w+/g, "") // strip #123, *ABC codes
      .replace(/\b\d{4,}\b/g, "") // strip long numbers (4+ digits)
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function tokenSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.split(/\s+/).filter((t) => t.length > 1));
  const tokensB = new Set(b.split(/\s+/).filter((t) => t.length > 1));

  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }

  const union = new Set([...tokensA, ...tokensB]).size;
  return union > 0 ? intersection / union : 0;
}

interface SimilarPayeeMatch {
  profile: PayeeProfile;
  similarity: number;
}

export function findSimilarPayees(
  targetName: string,
  allPayeeNames: Map<string, string>,
  profiles: Map<string, PayeeProfile>,
  maxResults: number,
): SimilarPayeeMatch[] {
  const normalizedTarget = normalizePayeeName(targetName);
  if (!normalizedTarget) return [];

  const candidates: SimilarPayeeMatch[] = [];
  const SIMILARITY_THRESHOLD = 0.4;

  for (const [payeeId, payeeName] of allPayeeNames) {
    const profile = profiles.get(payeeId);
    if (!profile || profile.total_count === 0) continue;

    const normalizedCandidate = normalizePayeeName(payeeName);
    const similarity = tokenSimilarity(normalizedTarget, normalizedCandidate);

    if (similarity >= SIMILARITY_THRESHOLD) {
      candidates.push({ profile, similarity });
    }
  }

  return candidates
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, maxResults);
}

function isAmountSimilar(a: number, b: number, tolerance: number): boolean {
  const absA = Math.abs(a);
  const absB = Math.abs(b);
  if (absA === 0 && absB === 0) return true;
  const diff = Math.abs(absA - absB);
  const max = Math.max(absA, absB);
  return diff / max <= tolerance;
}

function getDominantFromWeighted(profile: PayeeProfile): string | null {
  // Prefer recency-weighted scores
  if (profile.recency_weighted.size > 0) {
    return getDominantCategory(profile.recency_weighted);
  }
  return getDominantCategory(profile.category_counts);
}
