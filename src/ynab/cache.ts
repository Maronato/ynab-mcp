import type * as ynab from "ynab";

/** Default TTL: 1 hour. External changes are picked up after this period. */
export const CACHE_TTL_MS = 60 * 60 * 1000;

export interface SyncDeltas {
  added: number;
  updated: number;
  deleted: number;
}

export interface CollectionCache<T> {
  byId: Map<string, T>;
  serverKnowledge?: number;
  stale: boolean;
  lastRefreshedAt: number;
  lastDeltas?: SyncDeltas;
}

export interface TransactionCache {
  byId: Map<string, ynab.TransactionDetail>;
  coveredSinceDate: string;
  serverKnowledge?: number;
  stale: boolean;
  lastRefreshedAt: number;
  lastDeltas?: SyncDeltas;
}

export interface SimpleCache<T> {
  data: T;
  lastRefreshedAt: number;
}

export type StaleableCollectionKey =
  | "accounts"
  | "categories"
  | "payees"
  | "scheduledTransactions"
  | "transactions";

export interface BudgetCache {
  accounts: CollectionCache<ynab.Account>;
  categories: CollectionCache<ynab.Category>;
  payees: CollectionCache<ynab.Payee>;
  scheduledTransactions: CollectionCache<ynab.ScheduledTransactionDetail>;
  transactions: TransactionCache;
  categoryGroups: Map<string, ynab.CategoryGroupWithCategories>;
  settings?: SimpleCache<ynab.PlanSettings>;
  monthSummaries: Map<string, SimpleCache<ynab.MonthDetail>>;
  monthCategories: Map<string, SimpleCache<ynab.Category>>;
}

/**
 * Manages all per-budget caches (collection caches with delta sync, simple
 * TTL caches, optimistic updates) plus the top-level plans cache.
 *
 * This is an internal implementation detail of {@link YnabClient}; the public
 * API surface of the client is unchanged.
 */
export class CacheManager {
  private readonly budgetCaches = new Map<string, BudgetCache>();

  plansCache: SimpleCache<ynab.PlanSummary[]> | undefined;

  // -------------------------------------------------------------------------
  // Budget cache lifecycle
  // -------------------------------------------------------------------------

  getBudgetCache(budgetId: string): BudgetCache {
    const existing = this.budgetCaches.get(budgetId);
    if (existing) {
      return existing;
    }

    const cache: BudgetCache = {
      accounts: { byId: new Map(), stale: false, lastRefreshedAt: 0 },
      categories: { byId: new Map(), stale: false, lastRefreshedAt: 0 },
      payees: { byId: new Map(), stale: false, lastRefreshedAt: 0 },
      scheduledTransactions: {
        byId: new Map(),
        stale: false,
        lastRefreshedAt: 0,
      },
      transactions: {
        byId: new Map(),
        coveredSinceDate: "",
        stale: false,
        lastRefreshedAt: 0,
      },
      categoryGroups: new Map(),
      monthSummaries: new Map(),
      monthCategories: new Map(),
      settings: undefined,
    };

    this.budgetCaches.set(budgetId, cache);
    return cache;
  }

  // -------------------------------------------------------------------------
  // Staleness / TTL helpers
  // -------------------------------------------------------------------------

  markCollectionsStale(budgetId: string, keys: StaleableCollectionKey[]): void {
    const cache = this.getBudgetCache(budgetId);
    for (const key of keys) {
      cache[key].stale = true;
    }
  }

  invalidateMonthCaches(budgetId: string): void {
    const cache = this.getBudgetCache(budgetId);
    cache.monthSummaries.clear();
    cache.monthCategories.clear();
  }

  isSimpleCacheValid<T>(
    cache: SimpleCache<T> | undefined,
  ): cache is SimpleCache<T> {
    return cache != null && Date.now() - cache.lastRefreshedAt <= CACHE_TTL_MS;
  }

  needsRefresh(cache: {
    stale: boolean;
    lastRefreshedAt: number;
    serverKnowledge?: number;
  }): boolean {
    if (cache.serverKnowledge == null) return true;
    if (cache.stale) return true;
    return Date.now() - cache.lastRefreshedAt > CACHE_TTL_MS;
  }

  // -------------------------------------------------------------------------
  // Optimistic local cache updates after our own mutations
  // -------------------------------------------------------------------------

  optimisticUpdateTransactions(
    budgetId: string,
    transactions: ynab.TransactionDetail[],
  ): void {
    const cache = this.getBudgetCache(budgetId);
    const txCache = cache.transactions;
    if (txCache.serverKnowledge == null) return; // cache not yet populated

    for (const tx of transactions) {
      if (tx.date >= txCache.coveredSinceDate) {
        txCache.byId.set(tx.id, tx);
      }
    }
  }

  optimisticRemoveTransaction(budgetId: string, transactionId: string): void {
    const cache = this.getBudgetCache(budgetId);
    cache.transactions.byId.delete(transactionId);
  }

  optimisticUpdateScheduledTransaction(
    budgetId: string,
    transaction: ynab.ScheduledTransactionDetail,
  ): void {
    const cache = this.getBudgetCache(budgetId);
    if (cache.scheduledTransactions.serverKnowledge == null) return;
    cache.scheduledTransactions.byId.set(transaction.id, transaction);
  }

  optimisticRemoveScheduledTransaction(
    budgetId: string,
    scheduledTransactionId: string,
  ): void {
    const cache = this.getBudgetCache(budgetId);
    cache.scheduledTransactions.byId.delete(scheduledTransactionId);
  }

  // -------------------------------------------------------------------------
  // Collection refresh: accounts
  // -------------------------------------------------------------------------

  applyAccountDeltas(
    budgetId: string,
    accounts: ynab.Account[],
    serverKnowledge: number,
  ): ynab.Account[] {
    const cache = this.getBudgetCache(budgetId);
    const deltas: SyncDeltas = { added: 0, updated: 0, deleted: 0 };
    cache.accounts.serverKnowledge = serverKnowledge;
    for (const account of accounts) {
      if (account.deleted) {
        if (cache.accounts.byId.delete(account.id)) deltas.deleted++;
      } else if (cache.accounts.byId.has(account.id)) {
        cache.accounts.byId.set(account.id, account);
        deltas.updated++;
      } else {
        cache.accounts.byId.set(account.id, account);
        deltas.added++;
      }
    }
    cache.accounts.stale = false;
    cache.accounts.lastRefreshedAt = Date.now();
    cache.accounts.lastDeltas = deltas;

    return [...cache.accounts.byId.values()];
  }

  // -------------------------------------------------------------------------
  // Collection refresh: categories
  // -------------------------------------------------------------------------

  applyCategoryDeltas(
    budgetId: string,
    categoryGroups: ynab.CategoryGroupWithCategories[],
    serverKnowledge: number,
  ): ynab.CategoryGroupWithCategories[] {
    const cache = this.getBudgetCache(budgetId);
    const isDelta = cache.categories.serverKnowledge != null;

    const deltas: SyncDeltas = { added: 0, updated: 0, deleted: 0 };
    cache.categories.serverKnowledge = serverKnowledge;
    for (const group of categoryGroups) {
      if (group.deleted) {
        cache.categoryGroups.delete(group.id);
      } else if (!isDelta) {
        cache.categoryGroups.set(group.id, group);
      } else {
        const existing = cache.categoryGroups.get(group.id);
        cache.categoryGroups.set(group.id, {
          ...group,
          categories: existing?.categories ?? group.categories,
        });
      }

      for (const category of group.categories) {
        if (category.deleted) {
          if (cache.categories.byId.delete(category.id)) deltas.deleted++;
        } else if (cache.categories.byId.has(category.id)) {
          cache.categories.byId.set(category.id, category);
          deltas.updated++;
        } else {
          cache.categories.byId.set(category.id, category);
          deltas.added++;
        }
      }
    }

    if (isDelta) {
      // Rebuild each group's categories array from the authoritative byId map.
      // Delta responses only include changed categories, so the group objects
      // from the API have partial category lists. categories.byId is always
      // complete and correctly maintained, so we use it as the source of truth.
      const categoriesByGroup = new Map<string, ynab.Category[]>();
      for (const category of cache.categories.byId.values()) {
        const arr = categoriesByGroup.get(category.category_group_id);
        if (arr) {
          arr.push(category);
        } else {
          categoriesByGroup.set(category.category_group_id, [category]);
        }
      }
      for (const [groupId, group] of cache.categoryGroups) {
        cache.categoryGroups.set(groupId, {
          ...group,
          categories: categoriesByGroup.get(groupId) ?? [],
        });
      }
    }

    cache.categories.stale = false;
    cache.categories.lastRefreshedAt = Date.now();
    cache.categories.lastDeltas = deltas;

    return [...cache.categoryGroups.values()];
  }

  // -------------------------------------------------------------------------
  // Collection refresh: payees
  // -------------------------------------------------------------------------

  applyPayeeDeltas(
    budgetId: string,
    payees: ynab.Payee[],
    serverKnowledge: number,
  ): ynab.Payee[] {
    const cache = this.getBudgetCache(budgetId);
    const deltas: SyncDeltas = { added: 0, updated: 0, deleted: 0 };
    cache.payees.serverKnowledge = serverKnowledge;
    for (const payee of payees) {
      if (payee.deleted) {
        if (cache.payees.byId.delete(payee.id)) deltas.deleted++;
      } else if (cache.payees.byId.has(payee.id)) {
        cache.payees.byId.set(payee.id, payee);
        deltas.updated++;
      } else {
        cache.payees.byId.set(payee.id, payee);
        deltas.added++;
      }
    }
    cache.payees.stale = false;
    cache.payees.lastRefreshedAt = Date.now();
    cache.payees.lastDeltas = deltas;

    return [...cache.payees.byId.values()];
  }

  // -------------------------------------------------------------------------
  // Collection refresh: scheduled transactions
  // -------------------------------------------------------------------------

  applyScheduledTransactionDeltas(
    budgetId: string,
    transactions: ynab.ScheduledTransactionDetail[],
    serverKnowledge: number,
  ): ynab.ScheduledTransactionDetail[] {
    const cache = this.getBudgetCache(budgetId);
    const deltas: SyncDeltas = { added: 0, updated: 0, deleted: 0 };
    cache.scheduledTransactions.serverKnowledge = serverKnowledge;
    for (const transaction of transactions) {
      if (transaction.deleted) {
        if (cache.scheduledTransactions.byId.delete(transaction.id))
          deltas.deleted++;
      } else if (cache.scheduledTransactions.byId.has(transaction.id)) {
        cache.scheduledTransactions.byId.set(transaction.id, transaction);
        deltas.updated++;
      } else {
        cache.scheduledTransactions.byId.set(transaction.id, transaction);
        deltas.added++;
      }
    }
    cache.scheduledTransactions.stale = false;
    cache.scheduledTransactions.lastRefreshedAt = Date.now();
    cache.scheduledTransactions.lastDeltas = deltas;

    return [...cache.scheduledTransactions.byId.values()];
  }

  // -------------------------------------------------------------------------
  // Transaction cache: full fetch + delta refresh
  // -------------------------------------------------------------------------

  applyFullTransactionFetch(
    budgetId: string,
    transactions: ynab.TransactionDetail[],
    sinceDate: string,
    serverKnowledge: number,
  ): void {
    const cache = this.getBudgetCache(budgetId);
    const previousTransactions = new Map(cache.transactions.byId);

    const nextTransactions = new Map<string, ynab.TransactionDetail>();
    for (const tx of transactions) {
      if (!tx.deleted) {
        nextTransactions.set(tx.id, tx);
      }
    }

    let added = 0;
    let updated = 0;
    let deleted = 0;
    for (const id of nextTransactions.keys()) {
      if (previousTransactions.has(id)) {
        updated++;
      } else {
        added++;
      }
    }
    for (const id of previousTransactions.keys()) {
      if (!nextTransactions.has(id)) {
        deleted++;
      }
    }

    cache.transactions.byId.clear();
    for (const [id, tx] of nextTransactions) {
      cache.transactions.byId.set(id, tx);
    }
    cache.transactions.coveredSinceDate = sinceDate;
    cache.transactions.serverKnowledge = serverKnowledge;
    cache.transactions.stale = false;
    cache.transactions.lastRefreshedAt = Date.now();
    cache.transactions.lastDeltas = { added, updated, deleted };
  }

  applyTransactionDeltas(
    budgetId: string,
    transactions: ynab.TransactionDetail[],
    serverKnowledge: number,
  ): void {
    const cache = this.getBudgetCache(budgetId);
    const txCache = cache.transactions;

    const deltas: SyncDeltas = { added: 0, updated: 0, deleted: 0 };
    for (const tx of transactions) {
      if (tx.deleted) {
        if (txCache.byId.delete(tx.id)) deltas.deleted++;
      } else if (txCache.byId.has(tx.id)) {
        txCache.byId.set(tx.id, tx);
        deltas.updated++;
      } else {
        txCache.byId.set(tx.id, tx);
        deltas.added++;
      }
    }
    txCache.serverKnowledge = serverKnowledge;
    txCache.stale = false;
    txCache.lastRefreshedAt = Date.now();
    txCache.lastDeltas = deltas;
  }
}
