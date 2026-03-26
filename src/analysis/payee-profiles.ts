import type { YnabClient } from "../ynab/client.js";

export interface PayeeProfile {
  payee_id: string;
  payee_name: string;
  category_counts: Map<string, number>;
  recency_weighted: Map<string, number>;
  total_count: number;
  most_recent_category_id: string | null;
  most_recent_date: string | null;
  amount_buckets: AmountBucket[];
}

export interface AmountBucket {
  min: number;
  max: number;
  category_counts: Map<string, number>;
}

export const DEFAULT_HISTORY_MONTHS = 6;
const RECENCY_HALF_LIFE_DAYS = 60;

interface CacheEntry {
  profiles: Map<string, PayeeProfile>;
  sinceDate: string;
}

export class PayeeProfileAnalyzer {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly client: YnabClient) {}

  async getProfiles(
    budgetId: string,
    historyMonths = DEFAULT_HISTORY_MONTHS,
  ): Promise<Map<string, PayeeProfile>> {
    const requestedSinceDate = getHistorySinceDate(historyMonths);
    const existing = this.cache.get(budgetId);

    if (existing && existing.sinceDate <= requestedSinceDate) {
      return existing.profiles;
    }

    // Need to fetch — use the broader range (earlier date)
    const sinceDate =
      existing && existing.sinceDate < requestedSinceDate
        ? existing.sinceDate
        : requestedSinceDate;

    const profiles = await this.buildProfiles(budgetId, sinceDate);
    this.cache.set(budgetId, { profiles, sinceDate });
    return profiles;
  }

  invalidate(budgetId: string): void {
    this.cache.delete(budgetId);
  }

  private async buildProfiles(
    budgetId: string,
    sinceDate: string,
  ): Promise<Map<string, PayeeProfile>> {
    const transactions = await this.client.getTransactionsInRange(
      budgetId,
      sinceDate,
    );
    const payees = await this.client.getPayees(budgetId);
    const payeeNameById = new Map(payees.map((p) => [p.id, p.name]));

    const profiles = new Map<string, PayeeProfile>();
    const now = Date.now();

    for (const tx of transactions) {
      if (!tx.payee_id || !tx.category_id) continue;

      let profile = profiles.get(tx.payee_id);
      if (!profile) {
        profile = {
          payee_id: tx.payee_id,
          payee_name: payeeNameById.get(tx.payee_id) ?? tx.payee_id,
          category_counts: new Map(),
          recency_weighted: new Map(),
          total_count: 0,
          most_recent_category_id: null,
          most_recent_date: null,
          amount_buckets: [],
        };
        profiles.set(tx.payee_id, profile);
      }

      // Raw frequency
      profile.category_counts.set(
        tx.category_id,
        (profile.category_counts.get(tx.category_id) ?? 0) + 1,
      );
      profile.total_count += 1;

      // Recency weighting
      const txDate = new Date(tx.date).getTime();
      const daysSince = Math.max(0, (now - txDate) / (1000 * 60 * 60 * 24));
      const weight = Math.exp((-Math.LN2 * daysSince) / RECENCY_HALF_LIFE_DAYS);
      profile.recency_weighted.set(
        tx.category_id,
        (profile.recency_weighted.get(tx.category_id) ?? 0) + weight,
      );

      // Track most recent
      if (!profile.most_recent_date || tx.date > profile.most_recent_date) {
        profile.most_recent_date = tx.date;
        profile.most_recent_category_id = tx.category_id;
      }
    }

    // Build amount buckets per payee
    for (const [payeeId, profile] of profiles) {
      const payeeTxs = transactions.filter(
        (tx) => tx.payee_id === payeeId && tx.category_id,
      );
      profile.amount_buckets = buildAmountBuckets(payeeTxs);
    }

    return profiles;
  }
}

function getHistorySinceDate(months: number): string {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date.toISOString().slice(0, 10);
}

interface TransactionLike {
  amount: number;
  category_id?: string | null;
}

/**
 * Build amount buckets from transactions using natural clustering.
 * Groups transactions into ranges based on order-of-magnitude breaks,
 * then tracks category frequency per bucket.
 */
export function buildAmountBuckets(
  transactions: TransactionLike[],
): AmountBucket[] {
  if (transactions.length < 3) return [];

  const amounts = transactions
    .filter((tx) => tx.category_id)
    .map((tx) => ({
      amount: Math.abs(tx.amount),
      category_id: tx.category_id as string,
    }))
    .sort((a, b) => a.amount - b.amount);

  if (amounts.length < 3) return [];

  // Find natural break points using gaps > 2x the median gap
  const gaps: number[] = [];
  for (let i = 1; i < amounts.length; i++) {
    gaps.push(amounts[i].amount - amounts[i - 1].amount);
  }
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)];
  const breakThreshold = Math.max(medianGap * 3, 1000); // at least $1 in milliunits

  const buckets: AmountBucket[] = [];
  let bucketStart = 0;

  for (let i = 1; i <= amounts.length; i++) {
    const isBreak =
      i === amounts.length ||
      amounts[i].amount - amounts[i - 1].amount > breakThreshold;

    if (isBreak) {
      const slice = amounts.slice(bucketStart, i);
      const counts = new Map<string, number>();
      for (const item of slice) {
        counts.set(item.category_id, (counts.get(item.category_id) ?? 0) + 1);
      }

      // Only keep buckets with 2+ transactions
      if (slice.length >= 2) {
        buckets.push({
          min: slice[0].amount,
          max: slice[slice.length - 1].amount,
          category_counts: counts,
        });
      }

      bucketStart = i;
    }
  }

  // Only return buckets if we have multiple with different dominant categories
  if (buckets.length < 2) return [];

  const dominants = new Set(
    buckets.map((b) => getDominantCategory(b.category_counts)),
  );
  if (dominants.size < 2) return [];

  return buckets;
}

export function getDominantCategory(
  counts: Map<string, number>,
): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [catId, count] of counts) {
    if (count > bestCount) {
      best = catId;
      bestCount = count;
    }
  }
  return best;
}
