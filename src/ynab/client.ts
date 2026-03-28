import * as ynab from "ynab";
import { extractErrorMessage, isNotFoundError } from "./errors.js";
import {
  currencyToMilliunits,
  milliunitsToCurrency,
  snapshotScheduledTransaction,
  snapshotTransaction,
} from "./format.js";
import { RateLimiter } from "./rate-limiter.js";
import type {
  CategoryBudgetAssignment,
  CreateScheduledTransactionInput,
  CreateTransactionInput,
  NameLookup,
  ScheduledTransactionSnapshot,
  TransactionSearchQuery,
  TransactionSnapshot,
  UpdateScheduledTransactionInput,
  UpdateTransactionInput,
} from "./types.js";

/** Default TTL: 1 hour. External changes are picked up after this period. */
const CACHE_TTL_MS = 60 * 60 * 1000;

/** Default timeout for individual YNAB API requests. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Maximum number of retries for transient failures on read operations. */
const DEFAULT_MAX_RETRIES = 2;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() =>
    clearTimeout(timeoutId),
  );
}

function isTransientError(error: unknown): boolean {
  // Timeout errors from our own wrapper
  if (error instanceof Error && error.message.includes("timed out")) {
    return true;
  }
  // Network errors (fetch failures)
  if (error instanceof TypeError && error.message.includes("fetch")) {
    return true;
  }
  // 5xx server errors from the YNAB API (SDK throws objects with error.id)
  if (typeof error === "object" && error !== null && "error" in error) {
    const shaped = error as { error?: { id?: string } };
    const id = shaped.error?.id;
    if (typeof id === "string" && id.startsWith("5")) {
      return true;
    }
  }
  return false;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  shouldRetry: (error: unknown) => boolean,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries || !shouldRetry(error)) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1000 * 2 ** attempt, 5000)),
      );
    }
  }
  throw lastError;
}

const KNOWN_SUB_APIS = new Set([
  "plans",
  "accounts",
  "categories",
  "payees",
  "transactions",
  "scheduledTransactions",
  "months",
]);

interface SyncDeltas {
  added: number;
  updated: number;
  deleted: number;
}

interface CollectionCache<T> {
  byId: Map<string, T>;
  serverKnowledge?: number;
  stale: boolean;
  lastRefreshedAt: number;
  lastDeltas?: SyncDeltas;
}

interface TransactionCache {
  byId: Map<string, ynab.TransactionDetail>;
  coveredSinceDate: string;
  serverKnowledge?: number;
  stale: boolean;
  lastRefreshedAt: number;
  lastDeltas?: SyncDeltas;
}

interface SimpleCache<T> {
  data: T;
  lastRefreshedAt: number;
}

type StaleableCollectionKey =
  | "accounts"
  | "categories"
  | "payees"
  | "scheduledTransactions"
  | "transactions";

interface BudgetCache {
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

interface GetAccountsOptions {
  type?: string;
  onBudget?: boolean;
  includeClosed?: boolean;
}

interface GetCategoriesOptions {
  month?: string;
  groupId?: string;
  includeHidden?: boolean;
}

interface GetScheduledTransactionsOptions {
  accountId?: string;
  categoryId?: string;
  dueAfter?: string;
  dueBefore?: string;
}

const DEFAULT_ACCOUNT_OPTIONS: Required<
  Pick<GetAccountsOptions, "includeClosed">
> = {
  includeClosed: false,
};

const DEFAULT_CATEGORIES_OPTIONS: Required<
  Pick<GetCategoriesOptions, "includeHidden">
> = {
  includeHidden: false,
};

export class YnabClient {
  private readonly api: ynab.API;

  private readonly budgetCaches = new Map<string, BudgetCache>();

  private plansCache: SimpleCache<ynab.PlanSummary[]> | undefined;

  private resolvedLastUsedId: string | null = null;

  readonly readOnly: boolean;

  private readonly timeoutMs: number;

  private readonly maxRetries: number;

  constructor(
    accessToken: string,
    endpointUrl?: string,
    options?: { readOnly?: boolean; timeoutMs?: number; maxRetries?: number },
  ) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.api = this.withRateLimitAndResilience(
      new ynab.API(accessToken, endpointUrl),
      new RateLimiter(),
    );
    this.readOnly = options?.readOnly ?? false;
  }

  /**
   * Wraps the ynab API so that every SDK method call on known sub-APIs
   * automatically passes through the rate limiter, applies a timeout,
   * and retries transient failures for read-only (get/list) methods.
   */
  private withRateLimitAndResilience(
    api: ynab.API,
    rateLimiter: RateLimiter,
  ): ynab.API {
    const { timeoutMs, maxRetries } = this;
    return new Proxy(api, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof prop !== "string" || !KNOWN_SUB_APIS.has(prop)) {
          return value;
        }
        if (typeof value !== "object" || value === null) return value;

        // Wrap each known sub-API (e.g. api.transactions, api.accounts)
        return new Proxy(value as object, {
          get(subTarget, subProp, subReceiver) {
            const method = Reflect.get(subTarget, subProp, subReceiver);
            if (typeof method !== "function") return method;

            const isReadMethod =
              typeof subProp === "string" &&
              (subProp.startsWith("get") || subProp.startsWith("list"));

            return (...args: unknown[]) => {
              const invoke = (): unknown => {
                rateLimiter.trackCall();
                const result = (method as (...a: unknown[]) => unknown).apply(
                  subTarget,
                  args,
                );
                if (result instanceof Promise) {
                  return withTimeout(
                    result,
                    timeoutMs,
                    `YNAB API request timed out after ${timeoutMs / 1000} seconds.`,
                  );
                }
                return result;
              };

              if (isReadMethod) {
                return withRetry(
                  invoke as () => Promise<unknown>,
                  maxRetries,
                  isTransientError,
                );
              }
              return invoke();
            };
          },
        });
      },
    });
  }

  private assertWriteAllowed(): void {
    if (this.readOnly) {
      throw new Error(
        "Write operations are disabled (read-only mode). " +
          "Set YNAB_READ_ONLY=false to enable writes.",
      );
    }
  }

  resolveBudgetId(budgetId?: string): string {
    const id = budgetId ?? "last-used";
    if (id === "last-used" && this.resolvedLastUsedId) {
      return this.resolvedLastUsedId;
    }
    return id;
  }

  async resolveRealBudgetId(budgetId?: string): Promise<string> {
    const resolved = this.resolveBudgetId(budgetId);
    if (resolved !== "last-used") {
      return resolved;
    }

    if (this.resolvedLastUsedId) {
      return this.resolvedLastUsedId;
    }

    const budgets = await this.listBudgets();
    if (budgets.length === 0) {
      throw new Error(
        "No YNAB budgets available to resolve 'last-used'. Pass a specific budget_id.",
      );
    }

    const sorted = [...budgets].sort((a, b) =>
      (b.last_modified_on ?? "").localeCompare(a.last_modified_on ?? ""),
    );

    this.resolvedLastUsedId = sorted[0].id;
    return this.resolvedLastUsedId;
  }

  async listBudgets(): Promise<ynab.PlanSummary[]> {
    if (this.isSimpleCacheValid(this.plansCache)) {
      return this.plansCache.data;
    }

    const response = await this.api.plans.getPlans();
    const plans = response.data.plans;
    this.plansCache = { data: plans, lastRefreshedAt: Date.now() };
    return plans;
  }

  async getBudgetSettings(budgetId?: string): Promise<ynab.PlanSettings> {
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    const budgetCache = this.getBudgetCache(resolvedBudgetId);

    if (this.isSimpleCacheValid(budgetCache.settings)) {
      return budgetCache.settings.data;
    }

    const response = await this.api.plans.getPlanSettingsById(resolvedBudgetId);
    budgetCache.settings = {
      data: response.data.settings,
      lastRefreshedAt: Date.now(),
    };
    return budgetCache.settings.data;
  }

  async getBudgetSummary(budgetId?: string) {
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    const [accounts, month] = await Promise.all([
      this.getAccounts(resolvedBudgetId, { includeClosed: true }),
      this.getMonthSummary(resolvedBudgetId, "current"),
    ]);

    const netWorthMilliunits = accounts.reduce(
      (sum, account) => sum + account.balance,
      0,
    );

    const overspentCategoryCount = month.categories.filter(
      (category) =>
        category.balance < 0 && !category.hidden && !category.deleted,
    ).length;

    const accountsByType = new Map<
      string,
      { type: string; count: number; total_balance: number }
    >();

    for (const account of accounts) {
      const current = accountsByType.get(account.type) ?? {
        type: account.type,
        count: 0,
        total_balance: 0,
      };

      current.count += 1;
      current.total_balance += account.balance;
      accountsByType.set(account.type, current);
    }

    return {
      budget_id: resolvedBudgetId,
      month: month.month,
      net_worth_milliunits: netWorthMilliunits,
      net_worth: milliunitsToCurrency(netWorthMilliunits),
      income_milliunits: month.income,
      income: milliunitsToCurrency(month.income),
      budgeted_milliunits: month.budgeted,
      budgeted: milliunitsToCurrency(month.budgeted),
      activity_milliunits: month.activity,
      activity: milliunitsToCurrency(month.activity),
      to_be_budgeted_milliunits: month.to_be_budgeted,
      to_be_budgeted: milliunitsToCurrency(month.to_be_budgeted),
      age_of_money: month.age_of_money ?? null,
      overspent_category_count: overspentCategoryCount,
      account_summary_by_type: [...accountsByType.values()].map((entry) => ({
        type: entry.type,
        count: entry.count,
        total_balance_milliunits: entry.total_balance,
        total_balance: milliunitsToCurrency(entry.total_balance),
      })),
    };
  }

  async getAccounts(
    budgetId?: string,
    options: GetAccountsOptions = {},
  ): Promise<ynab.Account[]> {
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    const mergedOptions = {
      ...DEFAULT_ACCOUNT_OPTIONS,
      ...options,
    };

    const accounts = await this.refreshAccounts(resolvedBudgetId);

    return accounts
      .filter((account) => !account.deleted)
      .filter((account) => {
        if (!mergedOptions.includeClosed && account.closed) {
          return false;
        }

        if (mergedOptions.type && account.type !== mergedOptions.type) {
          return false;
        }

        if (
          mergedOptions.onBudget !== undefined &&
          account.on_budget !== mergedOptions.onBudget
        ) {
          return false;
        }

        return true;
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async getCategories(
    budgetId?: string,
    options: GetCategoriesOptions = {},
  ): Promise<Array<ynab.CategoryGroupWithCategories>> {
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    const mergedOptions = {
      ...DEFAULT_CATEGORIES_OPTIONS,
      ...options,
    };

    if (!mergedOptions.month || mergedOptions.month === "current") {
      await this.refreshCategories(resolvedBudgetId);
      const categoryGroups =
        this.getBudgetCache(resolvedBudgetId).categoryGroups;
      const entries = [...categoryGroups.values()]
        .filter((group) => !group.deleted)
        .filter((group) =>
          mergedOptions.groupId ? group.id === mergedOptions.groupId : true,
        )
        .map((group) => ({
          ...group,
          categories: group.categories
            .filter((category) => !category.deleted)
            .filter((category) =>
              mergedOptions.includeHidden ? true : !category.hidden,
            ),
        }));

      return entries;
    }

    // Recursive call: fetch the full category tree (no month filter, include hidden)
    // to get the group structure, then overlay month-specific budget data on top.
    const [month, categoryGroups] = await Promise.all([
      this.getMonthSummary(resolvedBudgetId, mergedOptions.month),
      this.getCategories(resolvedBudgetId, {
        includeHidden: true,
      }),
    ]);

    const categoriesById = new Map(
      month.categories.map((category) => [category.id, category]),
    );

    return categoryGroups
      .filter((group) => !group.deleted)
      .filter((group) =>
        mergedOptions.groupId ? group.id === mergedOptions.groupId : true,
      )
      .map((group) => ({
        ...group,
        categories: group.categories
          .map((category) => categoriesById.get(category.id) ?? category)
          .filter((category) => !category.deleted)
          .filter((category) =>
            mergedOptions.includeHidden ? true : !category.hidden,
          ),
      }));
  }

  async getMonthSummary(
    budgetId?: string,
    month = "current",
  ): Promise<ynab.MonthDetail> {
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    const budgetCache = this.getBudgetCache(resolvedBudgetId);
    const cached = budgetCache.monthSummaries.get(month);
    if (this.isSimpleCacheValid(cached)) {
      return cached.data;
    }

    const response = await this.api.months.getPlanMonth(
      resolvedBudgetId,
      month,
    );
    const monthSummary = response.data.month;
    budgetCache.monthSummaries.set(month, {
      data: monthSummary,
      lastRefreshedAt: Date.now(),
    });
    return monthSummary;
  }

  async getScheduledTransactions(
    budgetId?: string,
    options: GetScheduledTransactionsOptions = {},
  ): Promise<ynab.ScheduledTransactionDetail[]> {
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    const transactions =
      await this.refreshScheduledTransactions(resolvedBudgetId);

    return transactions
      .filter((transaction) => !transaction.deleted)
      .filter((transaction) => {
        if (options.accountId && transaction.account_id !== options.accountId) {
          return false;
        }

        if (
          options.categoryId &&
          transaction.category_id !== options.categoryId
        ) {
          return false;
        }

        if (options.dueAfter && transaction.date_next < options.dueAfter) {
          return false;
        }

        if (options.dueBefore && transaction.date_next > options.dueBefore) {
          return false;
        }

        return true;
      })
      .sort((left, right) => left.date_next.localeCompare(right.date_next));
  }

  async getPayees(budgetId?: string): Promise<ynab.Payee[]> {
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    const payees = await this.refreshPayees(resolvedBudgetId);
    return payees
      .filter((payee) => !payee.deleted)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async getNameLookup(budgetId?: string): Promise<NameLookup> {
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    const [accounts, categories, payees] = await Promise.all([
      this.getAccounts(resolvedBudgetId, { includeClosed: true }),
      this.getCategories(resolvedBudgetId, { includeHidden: true }),
      this.getPayees(resolvedBudgetId),
    ]);

    const accountById = new Map(
      accounts.map((account) => [account.id, account.name]),
    );
    const categoryById = new Map<
      string,
      { name: string; group_id: string; group_name: string }
    >();

    for (const group of categories) {
      for (const category of group.categories) {
        categoryById.set(category.id, {
          name: category.name,
          group_id: group.id,
          group_name: group.name,
        });
      }
    }

    const payeeById = new Map(payees.map((payee) => [payee.id, payee.name]));

    return {
      accountById,
      categoryById,
      payeeById,
    };
  }

  async searchTransactions(
    budgetId: string | undefined,
    query: TransactionSearchQuery,
  ): Promise<ynab.TransactionDetail[]> {
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    await this.ensureTransactionsCovered(resolvedBudgetId, query.since_date);

    const cache = this.getBudgetCache(resolvedBudgetId);
    const source = [...cache.transactions.byId.values()];

    const minimum =
      query.amount_min !== undefined
        ? currencyToMilliunits(query.amount_min)
        : undefined;
    const maximum =
      query.amount_max !== undefined
        ? currencyToMilliunits(query.amount_max)
        : undefined;
    const memoContains = query.memo_contains?.toLowerCase();
    const payeeNameContains = query.payee_name_contains?.toLowerCase();
    const categoryNameContains = query.category_name_contains?.toLowerCase();

    const filtered = source.filter((transaction) => {
      if (query.since_date && transaction.date < query.since_date) {
        return false;
      }

      if (query.until_date && transaction.date > query.until_date) {
        return false;
      }

      if (query.account_id && transaction.account_id !== query.account_id) {
        return false;
      }

      if (query.category_id && transaction.category_id !== query.category_id) {
        const subMatch = transaction.subtransactions?.some(
          (sub) => !sub.deleted && sub.category_id === query.category_id,
        );
        if (!subMatch) return false;
      }

      if (query.payee_id && transaction.payee_id !== query.payee_id) {
        return false;
      }

      if (minimum !== undefined && transaction.amount < minimum) {
        return false;
      }

      if (maximum !== undefined && transaction.amount > maximum) {
        return false;
      }

      if (
        memoContains &&
        !(transaction.memo ?? "").toLowerCase().includes(memoContains)
      ) {
        return false;
      }

      if (
        payeeNameContains &&
        !(transaction.payee_name ?? "")
          .toLowerCase()
          .includes(payeeNameContains)
      ) {
        return false;
      }

      if (
        categoryNameContains &&
        !(transaction.category_name ?? "")
          .toLowerCase()
          .includes(categoryNameContains)
      ) {
        const subNameMatch = transaction.subtransactions?.some(
          (sub) =>
            !sub.deleted &&
            (sub.category_name ?? "")
              .toLowerCase()
              .includes(categoryNameContains),
        );
        if (!subNameMatch) return false;
      }

      if (
        query.flag_color !== undefined &&
        transaction.flag_color !== query.flag_color
      ) {
        return false;
      }

      if (query.exclude_transfers && transaction.transfer_account_id != null) {
        return false;
      }

      if (
        query.cleared !== undefined &&
        transaction.cleared !== query.cleared
      ) {
        return false;
      }

      if (
        query.approved !== undefined &&
        transaction.approved !== query.approved
      ) {
        return false;
      }

      if (query.type === "uncategorized" && transaction.category_id != null) {
        const hasUncategorizedSub = transaction.subtransactions?.some(
          (sub) => !sub.deleted && sub.category_id == null,
        );
        if (!hasUncategorizedSub) return false;
      }
      if (query.type === "unapproved" && transaction.approved) {
        return false;
      }

      return true;
    });

    const sortDirection = query.sort ?? "date_desc";
    const sorted = [...filtered].sort((left, right) => {
      if (sortDirection === "date_asc") {
        return left.date.localeCompare(right.date);
      }

      return right.date.localeCompare(left.date);
    });

    const limit = query.limit ?? 50;
    return limit > 0 ? sorted.slice(0, limit) : sorted;
  }

  async getTransactionById(
    budgetId: string | undefined,
    transactionId: string,
  ): Promise<ynab.TransactionDetail | null> {
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    const cache = this.getBudgetCache(resolvedBudgetId);
    const txCache = cache.transactions;

    // Delta refresh only — never trigger a full re-fetch for a single-ID
    // lookup. ensureTransactionsCovered(budgetId) with no sinceDate would
    // compare coveredSinceDate <= "", which is false for any populated
    // cache, causing an unnecessary full re-fetch of ALL transactions.
    if (txCache.serverKnowledge != null && this.needsRefresh(txCache)) {
      await this.refreshTransactions(resolvedBudgetId);
    }

    const cached = txCache.byId.get(transactionId);
    if (cached) return cached;

    try {
      const response = await this.api.transactions.getTransactionById(
        resolvedBudgetId,
        transactionId,
      );
      return response.data.transaction;
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  async createTransactions(
    budgetId: string | undefined,
    transactions: CreateTransactionInput[],
  ): Promise<ynab.TransactionDetail[]> {
    this.assertWriteAllowed();
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    const payload: ynab.PostTransactionsWrapper = {
      transactions: transactions.map((transaction) => ({
        account_id: transaction.account_id,
        date: transaction.date,
        amount: currencyToMilliunits(transaction.amount),
        payee_id: transaction.payee_id ?? undefined,
        payee_name: transaction.payee_name ?? undefined,
        category_id: transaction.category_id ?? undefined,
        memo: transaction.memo ?? undefined,
        cleared: transaction.cleared as
          | ynab.TransactionClearedStatus
          | undefined,
        approved: transaction.approved,
        flag_color: transaction.flag_color as
          | ynab.TransactionFlagColor
          | null
          | undefined,
        subtransactions: transaction.subtransactions?.map((sub) => ({
          amount: currencyToMilliunits(sub.amount),
          payee_id: sub.payee_id ?? undefined,
          payee_name: sub.payee_name ?? undefined,
          category_id: sub.category_id ?? undefined,
          memo: sub.memo ?? undefined,
        })),
      })),
    };

    const response = await this.api.transactions.createTransactions(
      resolvedBudgetId,
      payload,
    );

    const created = response.data.transactions ?? [];
    this.markCollectionsStale(resolvedBudgetId, [
      "accounts",
      "payees",
      "categories",
    ]);
    this.invalidateMonthCaches(resolvedBudgetId);
    this.optimisticUpdateTransactions(resolvedBudgetId, created);
    return created;
  }

  async updateTransactions(
    budgetId: string | undefined,
    transactions: UpdateTransactionInput[],
  ): Promise<ynab.TransactionDetail[]> {
    this.assertWriteAllowed();
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    // The SDK's SaveTransactionWithIdOrImportId type doesn't allow null for
    // payee_id/category_id/memo, but the YNAB API accepts null to clear fields.
    // We cast the elements to work around this SDK codegen limitation.
    const payload: ynab.PatchTransactionsWrapper = {
      transactions: transactions.map((transaction) => ({
        id: transaction.transaction_id,
        ...(transaction.account_id !== undefined && {
          account_id: transaction.account_id,
        }),
        ...(transaction.date !== undefined && { date: transaction.date }),
        ...(transaction.amount !== undefined && {
          amount: currencyToMilliunits(transaction.amount),
        }),
        ...(transaction.payee_id !== undefined && {
          payee_id: transaction.payee_id,
        }),
        ...(transaction.payee_name !== undefined && {
          payee_name: transaction.payee_name,
        }),
        ...(transaction.category_id !== undefined && {
          category_id: transaction.category_id,
        }),
        ...(transaction.memo !== undefined && { memo: transaction.memo }),
        ...(transaction.cleared !== undefined && {
          cleared: transaction.cleared,
        }),
        ...(transaction.approved !== undefined && {
          approved: transaction.approved,
        }),
        ...(transaction.flag_color !== undefined && {
          flag_color: transaction.flag_color as ynab.TransactionFlagColor,
        }),
        ...(transaction.subtransactions !== undefined && {
          subtransactions: transaction.subtransactions.map((sub) => ({
            amount: currencyToMilliunits(sub.amount),
            payee_id: sub.payee_id ?? undefined,
            payee_name: sub.payee_name ?? undefined,
            category_id: sub.category_id ?? undefined,
            memo: sub.memo ?? undefined,
          })),
        }),
      })) as ynab.SaveTransactionWithIdOrImportId[],
    };

    const response = await this.api.transactions.updateTransactions(
      resolvedBudgetId,
      payload,
    );

    const updated = response.data.transactions ?? [];
    this.markCollectionsStale(resolvedBudgetId, [
      "accounts",
      "payees",
      "categories",
    ]);
    this.invalidateMonthCaches(resolvedBudgetId);
    this.optimisticUpdateTransactions(resolvedBudgetId, updated);
    return updated;
  }

  async replaceTransaction(
    budgetId: string | undefined,
    transactionId: string,
    replacement: CreateTransactionInput,
  ): Promise<{ transaction: ynab.TransactionDetail; previousId: string }> {
    this.assertWriteAllowed();
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    const deleted = await this.deleteTransaction(
      resolvedBudgetId,
      transactionId,
      { skipPhantomFlush: true },
    );
    if (!deleted) {
      throw new Error(
        `Transaction not found for replacement: ${transactionId}`,
      );
    }

    let created: ynab.TransactionDetail[];
    try {
      created = await this.createTransactions(resolvedBudgetId, [replacement]);
    } catch (error) {
      // Attempt to restore the original transaction to avoid data loss
      try {
        const activeSubs = deleted.subtransactions?.filter((s) => !s.deleted);
        await this.createTransactions(resolvedBudgetId, [
          {
            account_id: deleted.account_id,
            date: deleted.date,
            amount: milliunitsToCurrency(deleted.amount),
            payee_id: deleted.payee_id ?? null,
            payee_name: deleted.payee_name ?? null,
            category_id:
              activeSubs && activeSubs.length > 0
                ? undefined
                : (deleted.category_id ?? null),
            memo: deleted.memo ?? null,
            cleared: deleted.cleared as "cleared" | "uncleared" | "reconciled",
            approved: deleted.approved,
            flag_color: deleted.flag_color ?? null,
            subtransactions:
              activeSubs && activeSubs.length > 0
                ? activeSubs.map((sub) => ({
                    amount: milliunitsToCurrency(sub.amount),
                    payee_id: sub.payee_id ?? null,
                    category_id: sub.category_id ?? null,
                    memo: sub.memo ?? null,
                  }))
                : undefined,
          },
        ]);
      } catch {
        // Restore failed -- surface the original error with additional context
        throw new Error(
          `Failed to create replacement for transaction ${transactionId} after deleting the original, and automatic restore also failed. Manual recovery may be needed. ${extractErrorMessage(error)}`,
        );
      }
      throw new Error(
        `Failed to create replacement for transaction ${transactionId} after deleting the original. The original transaction was restored. ${extractErrorMessage(error)}`,
      );
    }

    const transaction = created[0];
    if (!transaction) {
      throw new Error(
        `Replacement for transaction ${transactionId} did not return a replacement transaction.`,
      );
    }

    // The YNAB API has a bug where deleting a split transaction leaves phantom
    // budget activity in the affected categories. Creating any transaction in
    // those categories forces a recalculation that clears the phantom. The
    // replacement's create already "touches" its own categories, so we only
    // need to flush categories from the old split that aren't in the new one.
    await this.flushSplitPhantoms(resolvedBudgetId, deleted, transaction);

    return { transaction, previousId: transactionId };
  }

  async deleteTransaction(
    budgetId: string | undefined,
    transactionId: string,
    options?: { skipPhantomFlush?: boolean },
  ): Promise<ynab.TransactionDetail | null> {
    this.assertWriteAllowed();
    try {
      const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
      const response = await this.api.transactions.deleteTransaction(
        resolvedBudgetId,
        transactionId,
      );
      this.markCollectionsStale(resolvedBudgetId, ["accounts", "categories"]);
      this.invalidateMonthCaches(resolvedBudgetId);
      this.optimisticRemoveTransaction(resolvedBudgetId, transactionId);
      const deleted = response.data.transaction;
      if (deleted && !options?.skipPhantomFlush) {
        await this.flushSplitPhantoms(resolvedBudgetId, deleted);
      }
      return deleted;
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  /**
   * Work around a YNAB API bug: deleting a split transaction does not remove
   * its subtransactions' budget activity. Creating (then deleting) a small
   * non-split transaction in each affected category forces a recalculation.
   *
   * When {@link replacementTransaction} is provided, categories already present
   * in the replacement are skipped since the create already flushed them.
   */
  private async flushSplitPhantoms(
    budgetId: string,
    deleted: ynab.TransactionDetail,
    replacementTransaction?: ynab.TransactionDetail,
  ): Promise<void> {
    // Don't filter by s.deleted here: the YNAB API marks all subtransactions
    // as deleted when the parent transaction is deleted, so the flag doesn't
    // distinguish individually-removed subs from parent-level deletion.
    const subs = deleted.subtransactions ?? [];
    if (subs.length === 0) return;

    const deletedCategoryIds = new Set(
      subs.map((s) => s.category_id).filter((id): id is string => !!id),
    );
    if (deletedCategoryIds.size === 0) return;

    if (replacementTransaction) {
      const replacementCategoryIds = new Set<string>();
      if (replacementTransaction.category_id) {
        replacementCategoryIds.add(replacementTransaction.category_id);
      }
      for (const sub of replacementTransaction.subtransactions ?? []) {
        if (sub.category_id && !sub.deleted) {
          replacementCategoryIds.add(sub.category_id);
        }
      }
      for (const id of replacementCategoryIds) {
        deletedCategoryIds.delete(id);
      }
    }

    if (deletedCategoryIds.size === 0) return;

    const categoryIds = [...deletedCategoryIds];
    const created = await this.createTransactions(
      budgetId,
      categoryIds.map((categoryId) => ({
        account_id: deleted.account_id,
        date: deleted.date,
        amount: -0.01,
        category_id: categoryId,
        approved: true,
      })),
    );

    await Promise.all(
      created.map((t) =>
        this.deleteTransaction(budgetId, t.id, { skipPhantomFlush: true }),
      ),
    );
  }

  async getScheduledTransactionById(
    budgetId: string | undefined,
    scheduledTransactionId: string,
  ): Promise<ynab.ScheduledTransactionDetail | null> {
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    const cache = this.getBudgetCache(resolvedBudgetId);
    const scheduledCache = cache.scheduledTransactions;

    if (
      scheduledCache.serverKnowledge != null &&
      this.needsRefresh(scheduledCache)
    ) {
      await this.refreshScheduledTransactions(resolvedBudgetId);
    }

    const cached = scheduledCache.byId.get(scheduledTransactionId);
    if (cached) return cached;

    try {
      const response =
        await this.api.scheduledTransactions.getScheduledTransactionById(
          resolvedBudgetId,
          scheduledTransactionId,
        );
      return response.data.scheduled_transaction;
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  async createScheduledTransaction(
    budgetId: string | undefined,
    transaction: CreateScheduledTransactionInput,
  ): Promise<ynab.ScheduledTransactionDetail> {
    this.assertWriteAllowed();
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    const response =
      await this.api.scheduledTransactions.createScheduledTransaction(
        resolvedBudgetId,
        {
          scheduled_transaction: {
            account_id: transaction.account_id,
            date: transaction.date,
            amount:
              transaction.amount !== undefined
                ? currencyToMilliunits(transaction.amount)
                : undefined,
            payee_id: transaction.payee_id,
            payee_name: transaction.payee_name,
            category_id: transaction.category_id,
            memo: transaction.memo,
            frequency:
              transaction.frequency as ynab.ScheduledTransactionFrequency,
            flag_color: transaction.flag_color as ynab.TransactionFlagColor,
          },
        },
      );

    this.markCollectionsStale(resolvedBudgetId, ["payees", "categories"]);
    this.optimisticUpdateScheduledTransaction(
      resolvedBudgetId,
      response.data.scheduled_transaction,
    );

    return response.data.scheduled_transaction;
  }

  async updateScheduledTransaction(
    budgetId: string | undefined,
    transaction: UpdateScheduledTransactionInput,
    prefetchedExisting?: ynab.ScheduledTransactionDetail,
  ): Promise<ynab.ScheduledTransactionDetail> {
    this.assertWriteAllowed();
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    const existing =
      prefetchedExisting ??
      (await this.getScheduledTransactionById(
        resolvedBudgetId,
        transaction.scheduled_transaction_id,
      ));

    if (!existing) {
      throw new Error(
        `Scheduled transaction not found: ${transaction.scheduled_transaction_id}`,
      );
    }

    const response =
      await this.api.scheduledTransactions.updateScheduledTransaction(
        resolvedBudgetId,
        transaction.scheduled_transaction_id,
        {
          scheduled_transaction: {
            account_id: transaction.account_id ?? existing.account_id,
            date: transaction.date ?? existing.date_first,
            amount:
              transaction.amount !== undefined
                ? currencyToMilliunits(transaction.amount)
                : existing.amount,
            payee_id:
              transaction.payee_id !== undefined
                ? transaction.payee_id
                : (existing.payee_id ?? undefined),
            payee_name: transaction.payee_name,
            category_id:
              transaction.category_id !== undefined
                ? transaction.category_id
                : (existing.category_id ?? undefined),
            memo:
              transaction.memo !== undefined
                ? transaction.memo
                : (existing.memo ?? undefined),
            ...(transaction.frequency !== undefined
              ? {
                  frequency:
                    transaction.frequency as ynab.ScheduledTransactionFrequency,
                }
              : {}),
            flag_color:
              transaction.flag_color !== undefined
                ? (transaction.flag_color as ynab.TransactionFlagColor)
                : existing.flag_color,
          },
        },
      );

    this.markCollectionsStale(resolvedBudgetId, ["payees", "categories"]);
    this.optimisticUpdateScheduledTransaction(
      resolvedBudgetId,
      response.data.scheduled_transaction,
    );

    return response.data.scheduled_transaction;
  }

  async deleteScheduledTransaction(
    budgetId: string | undefined,
    scheduledTransactionId: string,
  ): Promise<ynab.ScheduledTransactionDetail | null> {
    this.assertWriteAllowed();
    try {
      const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
      const response =
        await this.api.scheduledTransactions.deleteScheduledTransaction(
          resolvedBudgetId,
          scheduledTransactionId,
        );

      this.markCollectionsStale(resolvedBudgetId, ["categories"]);
      this.optimisticRemoveScheduledTransaction(
        resolvedBudgetId,
        scheduledTransactionId,
      );
      return response.data.scheduled_transaction;
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  async setCategoryBudget(
    budgetId: string | undefined,
    assignment: CategoryBudgetAssignment,
  ): Promise<ynab.Category> {
    this.assertWriteAllowed();
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    const response = await this.api.categories.updateMonthCategory(
      resolvedBudgetId,
      assignment.month,
      assignment.category_id,
      {
        category: {
          budgeted: currencyToMilliunits(assignment.budgeted),
        },
      },
    );

    this.markCollectionsStale(resolvedBudgetId, ["categories"]);
    this.invalidateMonthCaches(resolvedBudgetId);
    return response.data.category;
  }

  async updateCategory(
    budgetId: string,
    categoryId: string,
    updates: { goal_target?: number | null; goal_target_date?: string | null },
  ): Promise<ynab.Category> {
    this.assertWriteAllowed();
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    // The SDK's ExistingCategory type doesn't allow null for goal_target /
    // goal_target_date, but the YNAB API accepts null to clear fields.
    // We cast to work around this SDK codegen limitation.
    const response = await this.api.categories.updateCategory(
      resolvedBudgetId,
      categoryId,
      { category: updates } as ynab.PatchCategoryWrapper,
    );

    this.markCollectionsStale(resolvedBudgetId, ["categories"]);
    this.invalidateMonthCaches(resolvedBudgetId);
    return response.data.category;
  }

  async getCategoryById(
    budgetId: string,
    categoryId: string,
  ): Promise<ynab.Category | null> {
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    try {
      const response = await this.api.categories.getCategoryById(
        resolvedBudgetId,
        categoryId,
      );
      return response.data.category;
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  async getMonthCategoryById(
    budgetId: string | undefined,
    month: string,
    categoryId: string,
  ): Promise<ynab.Category | null> {
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    const budgetCache = this.getBudgetCache(resolvedBudgetId);
    const cacheKey = `${month}:${categoryId}`;
    const cached = budgetCache.monthCategories.get(cacheKey);
    if (this.isSimpleCacheValid(cached)) {
      return cached.data;
    }

    try {
      const response = await this.api.categories.getMonthCategoryById(
        resolvedBudgetId,
        month,
        categoryId,
      );
      const category = response.data.category;
      budgetCache.monthCategories.set(cacheKey, {
        data: category,
        lastRefreshedAt: Date.now(),
      });
      return category;
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  snapshotTransaction(
    transaction: ynab.TransactionDetail,
  ): TransactionSnapshot {
    return snapshotTransaction(transaction);
  }

  snapshotScheduledTransaction(
    transaction: ynab.ScheduledTransactionDetail,
  ): ScheduledTransactionSnapshot {
    return snapshotScheduledTransaction(transaction);
  }

  async getTransactionsInRange(
    budgetId: string | undefined,
    sinceDate: string,
    untilDate?: string,
  ): Promise<ynab.TransactionDetail[]> {
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    await this.ensureTransactionsCovered(resolvedBudgetId, sinceDate);

    const cache = this.getBudgetCache(resolvedBudgetId);
    const transactions = [...cache.transactions.byId.values()];

    return transactions.filter((t) => {
      if (t.date < sinceDate) return false;
      if (untilDate && t.date > untilDate) return false;
      return true;
    });
  }

  private getBudgetCache(budgetId: string): BudgetCache {
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

  private markCollectionsStale(
    budgetId: string,
    keys: StaleableCollectionKey[],
  ): void {
    const cache = this.getBudgetCache(budgetId);
    for (const key of keys) {
      cache[key].stale = true;
    }
  }

  private invalidateMonthCaches(budgetId: string): void {
    const cache = this.getBudgetCache(budgetId);
    cache.monthSummaries.clear();
    cache.monthCategories.clear();
  }

  private isSimpleCacheValid<T>(
    cache: SimpleCache<T> | undefined,
  ): cache is SimpleCache<T> {
    return cache != null && Date.now() - cache.lastRefreshedAt <= CACHE_TTL_MS;
  }

  private needsRefresh(cache: {
    stale: boolean;
    lastRefreshedAt: number;
    serverKnowledge?: number;
  }): boolean {
    if (cache.serverKnowledge == null) return true;
    if (cache.stale) return true;
    return Date.now() - cache.lastRefreshedAt > CACHE_TTL_MS;
  }

  /**
   * Force a delta refresh on all collections for a budget.
   * Called by the `sync_budget_data` tool.
   */
  async syncBudgetData(budgetId?: string): Promise<{
    accounts: { added: number; updated: number; deleted: number };
    categories: { added: number; updated: number; deleted: number };
    payees: { added: number; updated: number; deleted: number };
    scheduled_transactions: { added: number; updated: number; deleted: number };
    transactions: { added: number; updated: number; deleted: number };
  }> {
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    const cache = this.getBudgetCache(resolvedBudgetId);

    this.plansCache = undefined;
    cache.settings = undefined;
    cache.monthSummaries.clear();
    cache.monthCategories.clear();

    cache.accounts.stale = true;
    cache.categories.stale = true;
    cache.payees.stale = true;
    cache.scheduledTransactions.stale = true;
    cache.transactions.stale = true;

    await Promise.all([
      this.refreshAccounts(resolvedBudgetId),
      this.refreshCategories(resolvedBudgetId),
      this.refreshPayees(resolvedBudgetId),
      this.refreshScheduledTransactions(resolvedBudgetId),
      cache.transactions.serverKnowledge != null
        ? this.refreshTransactions(resolvedBudgetId)
        : this.fullFetchTransactions(
            resolvedBudgetId,
            cache.transactions.coveredSinceDate,
          ),
    ]);

    const zero = { added: 0, updated: 0, deleted: 0 };
    return {
      accounts: cache.accounts.lastDeltas ?? zero,
      categories: cache.categories.lastDeltas ?? zero,
      payees: cache.payees.lastDeltas ?? zero,
      scheduled_transactions: cache.scheduledTransactions.lastDeltas ?? zero,
      transactions: cache.transactions.lastDeltas ?? zero,
    };
  }

  // ---------------------------------------------------------------------------
  // Collection refresh methods (with freshness short-circuit)
  // ---------------------------------------------------------------------------

  private async refreshAccounts(budgetId: string): Promise<ynab.Account[]> {
    const cache = this.getBudgetCache(budgetId);
    if (!this.needsRefresh(cache.accounts)) {
      return [...cache.accounts.byId.values()];
    }

    const response = await this.api.accounts.getAccounts(
      budgetId,
      cache.accounts.serverKnowledge,
    );

    const deltas = { added: 0, updated: 0, deleted: 0 };
    cache.accounts.serverKnowledge = response.data.server_knowledge;
    for (const account of response.data.accounts) {
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

  private async refreshCategories(
    budgetId: string,
  ): Promise<Array<ynab.CategoryGroupWithCategories>> {
    const cache = this.getBudgetCache(budgetId);
    if (!this.needsRefresh(cache.categories)) {
      return [...cache.categoryGroups.values()];
    }

    const isDelta = cache.categories.serverKnowledge != null;

    const response = await this.api.categories.getCategories(
      budgetId,
      cache.categories.serverKnowledge,
    );

    const deltas = { added: 0, updated: 0, deleted: 0 };
    cache.categories.serverKnowledge = response.data.server_knowledge;
    for (const group of response.data.category_groups) {
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

  private async refreshPayees(budgetId: string): Promise<ynab.Payee[]> {
    const cache = this.getBudgetCache(budgetId);
    if (!this.needsRefresh(cache.payees)) {
      return [...cache.payees.byId.values()];
    }

    const response = await this.api.payees.getPayees(
      budgetId,
      cache.payees.serverKnowledge,
    );

    const deltas = { added: 0, updated: 0, deleted: 0 };
    cache.payees.serverKnowledge = response.data.server_knowledge;
    for (const payee of response.data.payees) {
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

  private async refreshScheduledTransactions(
    budgetId: string,
  ): Promise<ynab.ScheduledTransactionDetail[]> {
    const cache = this.getBudgetCache(budgetId);
    if (!this.needsRefresh(cache.scheduledTransactions)) {
      return [...cache.scheduledTransactions.byId.values()];
    }

    const response =
      await this.api.scheduledTransactions.getScheduledTransactions(
        budgetId,
        cache.scheduledTransactions.serverKnowledge,
      );

    const deltas = { added: 0, updated: 0, deleted: 0 };
    cache.scheduledTransactions.serverKnowledge =
      response.data.server_knowledge;
    for (const transaction of response.data.scheduled_transactions) {
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

  // ---------------------------------------------------------------------------
  // Transaction cache: population, delta refresh, since_date anchoring
  // ---------------------------------------------------------------------------

  /**
   * Ensure the transaction cache covers at least `sinceDate`.
   * - If uncovered or requesting older data: full fetch (resets SK).
   * - If covered but stale/TTL-expired: delta refresh.
   * - If covered and fresh: no-op.
   */
  private async ensureTransactionsCovered(
    budgetId: string,
    sinceDate?: string,
  ): Promise<void> {
    const cache = this.getBudgetCache(budgetId);
    const txCache = cache.transactions;
    const effectiveSinceDate = sinceDate ?? "";

    const isCovered =
      txCache.serverKnowledge != null &&
      txCache.coveredSinceDate <= effectiveSinceDate;

    if (!isCovered) {
      // Full fetch: either first time, or requesting older data than cached
      await this.fullFetchTransactions(budgetId, effectiveSinceDate);
      return;
    }

    if (this.needsRefresh(txCache)) {
      await this.refreshTransactions(budgetId);
    }
  }

  /** Full fetch (no SK). Replaces the transaction cache entirely. */
  private async fullFetchTransactions(
    budgetId: string,
    sinceDate: string,
  ): Promise<void> {
    const cache = this.getBudgetCache(budgetId);
    const previousTransactions = new Map(cache.transactions.byId);
    const response = await this.api.transactions.getTransactions(
      budgetId,
      sinceDate || undefined,
    );

    const nextTransactions = new Map<string, ynab.TransactionDetail>();
    for (const tx of response.data.transactions) {
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
    cache.transactions.serverKnowledge = response.data.server_knowledge;
    cache.transactions.stale = false;
    cache.transactions.lastRefreshedAt = Date.now();
    cache.transactions.lastDeltas = { added, updated, deleted };
  }

  /** Delta refresh using stored SK + coveredSinceDate. */
  private async refreshTransactions(budgetId: string): Promise<void> {
    const cache = this.getBudgetCache(budgetId);
    const txCache = cache.transactions;

    const response = await this.api.transactions.getTransactions(
      budgetId,
      txCache.coveredSinceDate || undefined,
      undefined,
      txCache.serverKnowledge,
    );

    const deltas = { added: 0, updated: 0, deleted: 0 };
    for (const tx of response.data.transactions) {
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
    txCache.serverKnowledge = response.data.server_knowledge;
    txCache.stale = false;
    txCache.lastRefreshedAt = Date.now();
    txCache.lastDeltas = deltas;
  }

  // ---------------------------------------------------------------------------
  // Optimistic local cache updates after our own mutations
  // ---------------------------------------------------------------------------

  private optimisticUpdateTransactions(
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

  private optimisticRemoveTransaction(
    budgetId: string,
    transactionId: string,
  ): void {
    const cache = this.getBudgetCache(budgetId);
    cache.transactions.byId.delete(transactionId);
  }

  private optimisticUpdateScheduledTransaction(
    budgetId: string,
    transaction: ynab.ScheduledTransactionDetail,
  ): void {
    const cache = this.getBudgetCache(budgetId);
    if (cache.scheduledTransactions.serverKnowledge == null) return;
    cache.scheduledTransactions.byId.set(transaction.id, transaction);
  }

  private optimisticRemoveScheduledTransaction(
    budgetId: string,
    scheduledTransactionId: string,
  ): void {
    const cache = this.getBudgetCache(budgetId);
    cache.scheduledTransactions.byId.delete(scheduledTransactionId);
  }
}
