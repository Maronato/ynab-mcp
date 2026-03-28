import type { YnabClient } from "../ynab/client.js";

export interface PayeeProfile {
  payee_id: string;
  payee_name: string;
  category_counts: Map<string, number>;
  recency_weighted: Map<string, number>;
  total_count: number;
  most_recent_category_id: string | null;
  most_recent_date: string | null;
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
      if (!tx.payee_id) continue;

      const activeSubs =
        (
          tx as {
            subtransactions?: Array<{
              amount: number;
              payee_id?: string | null;
              category_id?: string | null;
              memo?: string | null;
              deleted?: boolean;
            }>;
          }
        ).subtransactions?.filter((s) => !s.deleted) ?? [];
      const isSplit = activeSubs.length > 0;

      if (isSplit) {
        for (const sub of activeSubs) {
          if (!sub.category_id) continue;
          const categoryId = sub.category_id;

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
            };
            profiles.set(tx.payee_id, profile);
          }

          profile.category_counts.set(
            categoryId,
            (profile.category_counts.get(categoryId) ?? 0) + 1,
          );
          profile.total_count += 1;

          const txDate = new Date(tx.date).getTime();
          const daysSince = Math.max(0, (now - txDate) / (1000 * 60 * 60 * 24));
          const weight = Math.exp(
            (-Math.LN2 * daysSince) / RECENCY_HALF_LIFE_DAYS,
          );
          profile.recency_weighted.set(
            categoryId,
            (profile.recency_weighted.get(categoryId) ?? 0) + weight,
          );

          if (!profile.most_recent_date || tx.date > profile.most_recent_date) {
            profile.most_recent_date = tx.date;
            profile.most_recent_category_id = categoryId;
          }
        }
      } else {
        if (!tx.category_id) continue;

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
          };
          profiles.set(tx.payee_id, profile);
        }

        profile.category_counts.set(
          tx.category_id,
          (profile.category_counts.get(tx.category_id) ?? 0) + 1,
        );
        profile.total_count += 1;

        const txDate = new Date(tx.date).getTime();
        const daysSince = Math.max(0, (now - txDate) / (1000 * 60 * 60 * 24));
        const weight = Math.exp(
          (-Math.LN2 * daysSince) / RECENCY_HALF_LIFE_DAYS,
        );
        profile.recency_weighted.set(
          tx.category_id,
          (profile.recency_weighted.get(tx.category_id) ?? 0) + weight,
        );

        if (!profile.most_recent_date || tx.date > profile.most_recent_date) {
          profile.most_recent_date = tx.date;
          profile.most_recent_category_id = tx.category_id;
        }
      }
    }

    return profiles;
  }
}

function getHistorySinceDate(months: number): string {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date.toISOString().slice(0, 10);
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
