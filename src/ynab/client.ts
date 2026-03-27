import * as ynab from "ynab";
import { isNotFoundError } from "./errors.js";
import {
  currencyToMilliunits,
  snapshotScheduledTransaction,
  snapshotTransaction,
} from "./format.js";
import { RateLimiter } from "./rate-limiter.js";
import type {
  CategoryBudgetAssignment,
  CreateScheduledTransactionInput,
  CreateTransactionInput,
  NameLookup,
  TransactionSearchQuery,
  UpdateScheduledTransactionInput,
  UpdateTransactionInput,
} from "./types.js";

/** Default TTL: 1 hour. External changes are picked up after this period. */
const CACHE_TTL_MS = 60 * 60 * 1000;

const KNOWN_SUB_APIS = new Set([
  "plans",
  "accounts",
  "categories",
  "payees",
  "transactions",
  "scheduledTransactions",
  "months",
]);

interface CollectionCache<T> {
  byId: Map<string, T>;
  serverKnowledge?: number;
  stale: boolean;
  lastRefreshedAt: number;
}

interface TransactionCache {
  byId: Map<string, ynab.TransactionDetail>;
  coveredSinceDate: string;
  serverKnowledge?: number;
  stale: boolean;
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
  settings?: ynab.PlanSettings;
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

  private resolvedLastUsedId: string | null = null;

  readonly readOnly: boolean;

  constructor(
    accessToken: string,
    endpointUrl?: string,
    options?: { readOnly?: boolean },
  ) {
    this.api = this.withRateLimit(
      new ynab.API(accessToken, endpointUrl),
      new RateLimiter(),
    );
    this.readOnly = options?.readOnly ?? false;
  }

  /**
   * Wraps the ynab API so that every SDK method call on known sub-APIs
   * automatically passes through the rate limiter.
   */
  private withRateLimit(api: ynab.API, rateLimiter: RateLimiter): ynab.API {
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

            return (...args: unknown[]) => {
              rateLimiter.trackCall();
              return (method as (...a: unknown[]) => unknown).apply(
                subTarget,
                args,
              );
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
    const response = await this.api.plans.getPlans();
    return response.data.plans;
  }

  async getBudgetSettings(budgetId?: string): Promise<ynab.PlanSettings> {
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    const budgetCache = this.getBudgetCache(resolvedBudgetId);

    if (budgetCache.settings) {
      return budgetCache.settings;
    }

    const response = await this.api.plans.getPlanSettingsById(resolvedBudgetId);
    budgetCache.settings = response.data.settings;
    return response.data.settings;
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
      net_worth: netWorthMilliunits / 1000,
      income_milliunits: month.income,
      income: month.income / 1000,
      budgeted_milliunits: month.budgeted,
      budgeted: month.budgeted / 1000,
      activity_milliunits: month.activity,
      activity: month.activity / 1000,
      to_be_budgeted_milliunits: month.to_be_budgeted,
      to_be_budgeted: month.to_be_budgeted / 1000,
      age_of_money: month.age_of_money ?? null,
      overspent_category_count: overspentCategoryCount,
      account_summary_by_type: [...accountsByType.values()].map((entry) => ({
        type: entry.type,
        count: entry.count,
        total_balance_milliunits: entry.total_balance,
        total_balance: entry.total_balance / 1000,
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
          .map((category) => categoriesById.get(category.id))
          .filter((category): category is ynab.Category => Boolean(category))
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
    const response = await this.api.months.getPlanMonth(
      resolvedBudgetId,
      month,
    );
    return response.data.month;
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
    const categoryById = new Map<string, string>();

    for (const group of categories) {
      for (const category of group.categories) {
        categoryById.set(category.id, category.name);
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
        return false;
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

      if (query.cleared !== undefined) {
        const isCleared = transaction.cleared !== "uncleared";
        if (isCleared !== query.cleared) {
          return false;
        }
      }

      if (
        query.approved !== undefined &&
        transaction.approved !== query.approved
      ) {
        return false;
      }

      // Local equivalent of the server-side `type` filter
      if (query.type === "uncategorized" && transaction.category_id != null) {
        return false;
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

    // Ensure the cache is fresh (delta refresh if stale/TTL-expired)
    await this.ensureTransactionsCovered(resolvedBudgetId);

    const cache = this.getBudgetCache(resolvedBudgetId);
    const cached = cache.transactions.byId.get(transactionId);
    if (cached) return cached;

    // Fallback to API for transactions outside the cached date range
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
    this.optimisticUpdateTransactions(resolvedBudgetId, updated);
    return updated;
  }

  async deleteTransaction(
    budgetId: string | undefined,
    transactionId: string,
  ): Promise<ynab.TransactionDetail | null> {
    this.assertWriteAllowed();
    try {
      const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
      const response = await this.api.transactions.deleteTransaction(
        resolvedBudgetId,
        transactionId,
      );
      this.markCollectionsStale(resolvedBudgetId, ["accounts", "categories"]);
      this.optimisticRemoveTransaction(resolvedBudgetId, transactionId);
      return response.data.transaction;
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  async getScheduledTransactionById(
    budgetId: string | undefined,
    scheduledTransactionId: string,
  ): Promise<ynab.ScheduledTransactionDetail | null> {
    try {
      const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
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
            frequency: transaction.frequency
              ? (transaction.frequency as ynab.ScheduledTransactionFrequency)
              : existing.frequency,
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
    return response.data.category;
  }

  async getMonthCategoryById(
    budgetId: string | undefined,
    month: string,
    categoryId: string,
  ): Promise<ynab.Category | null> {
    try {
      const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
      const response = await this.api.categories.getMonthCategoryById(
        resolvedBudgetId,
        month,
        categoryId,
      );
      return response.data.category;
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  snapshotTransaction(
    transaction: ynab.TransactionDetail,
  ): Record<string, unknown> {
    return snapshotTransaction(transaction);
  }

  snapshotScheduledTransaction(
    transaction: ynab.ScheduledTransactionDetail,
  ): Record<string, unknown> {
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
    accounts: number;
    categories: number;
    payees: number;
    scheduledTransactions: number;
    transactions: number;
  }> {
    const resolvedBudgetId = await this.resolveRealBudgetId(budgetId);
    const cache = this.getBudgetCache(resolvedBudgetId);

    // Mark all stale to force delta refresh
    cache.accounts.stale = true;
    cache.categories.stale = true;
    cache.payees.stale = true;
    cache.scheduledTransactions.stale = true;
    cache.transactions.stale = true;

    const beforeCounts = {
      accounts: cache.accounts.byId.size,
      categories: cache.categories.byId.size,
      payees: cache.payees.byId.size,
      scheduledTransactions: cache.scheduledTransactions.byId.size,
      transactions: cache.transactions.byId.size,
    };

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

    return {
      accounts: cache.accounts.byId.size - beforeCounts.accounts,
      categories: cache.categories.byId.size - beforeCounts.categories,
      payees: cache.payees.byId.size - beforeCounts.payees,
      scheduledTransactions:
        cache.scheduledTransactions.byId.size -
        beforeCounts.scheduledTransactions,
      transactions: cache.transactions.byId.size - beforeCounts.transactions,
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

    cache.accounts.serverKnowledge = response.data.server_knowledge;
    for (const account of response.data.accounts) {
      if (account.deleted) {
        cache.accounts.byId.delete(account.id);
      } else {
        cache.accounts.byId.set(account.id, account);
      }
    }
    cache.accounts.stale = false;
    cache.accounts.lastRefreshedAt = Date.now();

    return [...cache.accounts.byId.values()];
  }

  private async refreshCategories(
    budgetId: string,
  ): Promise<Array<ynab.CategoryGroupWithCategories>> {
    const cache = this.getBudgetCache(budgetId);
    if (!this.needsRefresh(cache.categories)) {
      return [...cache.categoryGroups.values()];
    }

    const response = await this.api.categories.getCategories(
      budgetId,
      cache.categories.serverKnowledge,
    );

    cache.categories.serverKnowledge = response.data.server_knowledge;
    for (const group of response.data.category_groups) {
      if (group.deleted) {
        cache.categoryGroups.delete(group.id);
      } else {
        cache.categoryGroups.set(group.id, group);
      }

      for (const category of group.categories) {
        if (category.deleted) {
          cache.categories.byId.delete(category.id);
        } else {
          cache.categories.byId.set(category.id, category);
        }
      }
    }
    cache.categories.stale = false;
    cache.categories.lastRefreshedAt = Date.now();

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

    cache.payees.serverKnowledge = response.data.server_knowledge;
    for (const payee of response.data.payees) {
      if (payee.deleted) {
        cache.payees.byId.delete(payee.id);
      } else {
        cache.payees.byId.set(payee.id, payee);
      }
    }
    cache.payees.stale = false;
    cache.payees.lastRefreshedAt = Date.now();

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

    cache.scheduledTransactions.serverKnowledge =
      response.data.server_knowledge;
    for (const transaction of response.data.scheduled_transactions) {
      if (transaction.deleted) {
        cache.scheduledTransactions.byId.delete(transaction.id);
      } else {
        cache.scheduledTransactions.byId.set(transaction.id, transaction);
      }
    }
    cache.scheduledTransactions.stale = false;
    cache.scheduledTransactions.lastRefreshedAt = Date.now();

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
    const response = await this.api.transactions.getTransactions(
      budgetId,
      sinceDate || undefined,
    );

    cache.transactions.byId.clear();
    for (const tx of response.data.transactions) {
      if (!tx.deleted) {
        cache.transactions.byId.set(tx.id, tx);
      }
    }
    cache.transactions.coveredSinceDate = sinceDate;
    cache.transactions.serverKnowledge = response.data.server_knowledge;
    cache.transactions.stale = false;
    cache.transactions.lastRefreshedAt = Date.now();
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

    for (const tx of response.data.transactions) {
      if (tx.deleted) {
        txCache.byId.delete(tx.id);
      } else {
        txCache.byId.set(tx.id, tx);
      }
    }
    txCache.serverKnowledge = response.data.server_knowledge;
    txCache.stale = false;
    txCache.lastRefreshedAt = Date.now();
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
