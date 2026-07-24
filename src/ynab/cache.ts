import type * as ynab from "ynab";

/** Default TTL: 1 hour. External changes are picked up after this period. */
export const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Default TTL for completed past months: 24 hours. Past-month summaries and
 * category snapshots only change on retroactive edits, and refreshing them
 * is a full re-fetch (no delta sync), so they get a much longer TTL.
 */
export const PAST_MONTH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface CacheTtlOptions {
  ttlMs?: number;
  pastMonthTtlMs?: number;
}

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

export interface MoneyMovementsSnapshot {
  movements: ynab.MoneyMovement[];
  groups: ynab.MoneyMovementGroup[];
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
  /** All month summaries, keyed by month date (YYYY-MM-01). Delta-capable
   * via the months-list endpoint; one call replaces up to 12 per-month
   * fetches for aggregate-only consumers. */
  months: CollectionCache<ynab.MonthSummary>;
  categoryGroups: Map<string, ynab.CategoryGroupWithCategories>;
  settings?: SimpleCache<ynab.PlanSettings>;
  monthSummaries: Map<string, SimpleCache<ynab.MonthDetail>>;
  monthCategories: Map<string, SimpleCache<ynab.Category>>;
  /** Keyed by month (YYYY-MM-DD) or "all". Full-fetch only: the money
   * movement endpoints accept no last_knowledge_of_server parameter. */
  moneyMovements: Map<string, SimpleCache<MoneyMovementsSnapshot>>;
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

  private readonly ttlMs: number;

  private readonly pastMonthTtlMs: number;

  plansCache: SimpleCache<ynab.PlanSummary[]> | undefined;

  constructor(options: CacheTtlOptions = {}) {
    this.ttlMs = options.ttlMs ?? CACHE_TTL_MS;
    this.pastMonthTtlMs = options.pastMonthTtlMs ?? PAST_MONTH_CACHE_TTL_MS;
  }

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
      months: { byId: new Map(), stale: false, lastRefreshedAt: 0 },
      categoryGroups: new Map(),
      monthSummaries: new Map(),
      monthCategories: new Map(),
      moneyMovements: new Map(),
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
    // The months collection is delta-capable, so a cheap delta refresh
    // (rather than a full drop) picks up the write's effects.
    cache.months.stale = true;
    // Budget writes create money movements server-side
    cache.moneyMovements.clear();
  }

  isSimpleCacheValid<T>(
    cache: SimpleCache<T> | undefined,
  ): cache is SimpleCache<T> {
    return cache != null && Date.now() - cache.lastRefreshedAt <= this.ttlMs;
  }

  /**
   * Validity check for month-keyed caches: completed past months use the
   * longer past-month TTL, the current/future month (and the "current"
   * alias) uses the standard TTL.
   */
  isMonthCacheValid<T>(
    cache: SimpleCache<T> | undefined,
    month: string,
  ): cache is SimpleCache<T> {
    if (cache == null) return false;
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const isPastMonth = /^\d{4}-\d{2}/.test(month) && month < currentMonth;
    const ttl = isPastMonth ? this.pastMonthTtlMs : this.ttlMs;
    return Date.now() - cache.lastRefreshedAt <= ttl;
  }

  needsRefresh(cache: {
    stale: boolean;
    lastRefreshedAt: number;
    serverKnowledge?: number;
  }): boolean {
    if (cache.serverKnowledge == null) return true;
    if (cache.stale) return true;
    return Date.now() - cache.lastRefreshedAt > this.ttlMs;
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
  // Collection refresh: months
  // -------------------------------------------------------------------------

  applyMonthDeltas(
    budgetId: string,
    months: ynab.MonthSummary[],
    serverKnowledge: number,
  ): ynab.MonthSummary[] {
    const cache = this.getBudgetCache(budgetId);
    const deltas: SyncDeltas = { added: 0, updated: 0, deleted: 0 };
    cache.months.serverKnowledge = serverKnowledge;
    for (const month of months) {
      if (month.deleted) {
        if (cache.months.byId.delete(month.month)) deltas.deleted++;
      } else if (cache.months.byId.has(month.month)) {
        cache.months.byId.set(month.month, month);
        deltas.updated++;
      } else {
        cache.months.byId.set(month.month, month);
        deltas.added++;
      }
    }
    cache.months.stale = false;
    cache.months.lastRefreshedAt = Date.now();
    cache.months.lastDeltas = deltas;

    return [...cache.months.byId.values()];
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
