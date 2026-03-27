import * as ynab from "ynab";
import { isNotFoundError } from "./errors.js";
import {
  currencyToMilliunits,
  snapshotScheduledTransaction,
  snapshotTransaction,
} from "./format.js";
import type {
  CategoryBudgetAssignment,
  CreateScheduledTransactionInput,
  CreateTransactionInput,
  NameLookup,
  TransactionSearchQuery,
  UpdateScheduledTransactionInput,
  UpdateTransactionInput,
} from "./types.js";

interface CollectionCache<T> {
  byId: Map<string, T>;
  serverKnowledge?: number;
}

interface BudgetCache {
  accounts: CollectionCache<ynab.Account>;
  categories: CollectionCache<ynab.Category>;
  payees: CollectionCache<ynab.Payee>;
  scheduledTransactions: CollectionCache<ynab.ScheduledTransactionDetail>;
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

const RATE_LIMIT_MAX = 200;
const RATE_LIMIT_THRESHOLD = 190;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export class YnabClient {
  private readonly api: ynab.API;

  private readonly budgetCaches = new Map<string, BudgetCache>();

  private resolvedLastUsedId: string | null = null;

  readonly readOnly: boolean;

  private readonly apiCallTimestamps: number[] = [];

  constructor(
    accessToken: string,
    endpointUrl?: string,
    options?: { readOnly?: boolean },
  ) {
    this.api = this.withRateLimit(new ynab.API(accessToken, endpointUrl));
    this.readOnly = options?.readOnly ?? false;
  }

  private trackApiCall(): void {
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW_MS;

    // Prune old entries when the array grows large
    if (this.apiCallTimestamps.length > RATE_LIMIT_MAX * 2) {
      const firstValid = this.apiCallTimestamps.findIndex(
        (t) => t > windowStart,
      );
      if (firstValid > 0) {
        this.apiCallTimestamps.splice(0, firstValid);
      }
    }

    const recentCount = this.apiCallTimestamps.filter(
      (t) => t > windowStart,
    ).length;

    if (recentCount >= RATE_LIMIT_THRESHOLD) {
      const oldest = this.apiCallTimestamps.find((t) => t > windowStart) ?? now;
      const resetMinutes = Math.ceil(
        (oldest + RATE_LIMIT_WINDOW_MS - now) / 60000,
      );
      throw new Error(
        `YNAB API rate limit approaching (${recentCount}/${RATE_LIMIT_MAX} requests in the last hour). ` +
          `Try again in ~${resetMinutes} minutes.`,
      );
    }

    this.apiCallTimestamps.push(now);
  }

  /**
   * Wraps the ynab API so that every SDK method call automatically
   * passes through the rate limiter.
   */
  private withRateLimit(api: ynab.API): ynab.API {
    const client = this;
    return new Proxy(api, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "object" || value === null) return value;

        // Wrap each sub-API (e.g. api.transactions, api.accounts)
        return new Proxy(value as object, {
          get(subTarget, subProp, subReceiver) {
            const method = Reflect.get(subTarget, subProp, subReceiver);
            if (typeof method !== "function") return method;

            return (...args: unknown[]) => {
              client.trackApiCall();
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

    try {
      const budgets = await this.listBudgets();
      if (budgets.length === 0) {
        return resolved;
      }

      const sorted = [...budgets].sort((a, b) =>
        (b.last_modified_on ?? "").localeCompare(a.last_modified_on ?? ""),
      );

      this.resolvedLastUsedId = sorted[0].id;
      return this.resolvedLastUsedId;
    } catch {
      return resolved;
    }
  }

  async listBudgets(): Promise<ynab.PlanSummary[]> {
    const response = await this.api.plans.getPlans();
    return response.data.plans;
  }

  async getBudgetSettings(budgetId?: string): Promise<ynab.PlanSettings> {
    const resolvedBudgetId = this.resolveBudgetId(budgetId);
    const budgetCache = this.getBudgetCache(resolvedBudgetId);

    if (budgetCache.settings) {
      return budgetCache.settings;
    }

    const response = await this.api.plans.getPlanSettingsById(resolvedBudgetId);
    budgetCache.settings = response.data.settings;
    return response.data.settings;
  }

  async getBudgetSummary(budgetId?: string) {
    const resolvedBudgetId = this.resolveBudgetId(budgetId);
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
    const resolvedBudgetId = this.resolveBudgetId(budgetId);
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
    const resolvedBudgetId = this.resolveBudgetId(budgetId);
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
    const resolvedBudgetId = this.resolveBudgetId(budgetId);
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
    const resolvedBudgetId = this.resolveBudgetId(budgetId);
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
    const resolvedBudgetId = this.resolveBudgetId(budgetId);
    const payees = await this.refreshPayees(resolvedBudgetId);
    return payees
      .filter((payee) => !payee.deleted)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async getNameLookup(budgetId?: string): Promise<NameLookup> {
    const resolvedBudgetId = this.resolveBudgetId(budgetId);
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
    const resolvedBudgetId = this.resolveBudgetId(budgetId);
    const source = await this.getTransactionsFromBestEndpoint(
      resolvedBudgetId,
      query,
    );

    const minimum =
      query.amount_min !== undefined
        ? currencyToMilliunits(query.amount_min)
        : undefined;
    const maximum =
      query.amount_max !== undefined
        ? currencyToMilliunits(query.amount_max)
        : undefined;
    const memoContains = query.memo_contains?.toLowerCase();

    const filtered = source
      .filter((transaction) => !transaction.deleted)
      .filter((transaction) => {
        if (query.until_date && transaction.date > query.until_date) {
          return false;
        }

        if (query.account_id && transaction.account_id !== query.account_id) {
          return false;
        }

        if (
          query.category_id &&
          transaction.category_id !== query.category_id
        ) {
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
    try {
      const resolvedBudgetId = this.resolveBudgetId(budgetId);
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
    const resolvedBudgetId = this.resolveBudgetId(budgetId);
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

    this.invalidateBudgetCache(resolvedBudgetId, [
      "accounts",
      "payees",
      "categories",
    ]);
    return response.data.transactions ?? [];
  }

  async updateTransactions(
    budgetId: string | undefined,
    transactions: UpdateTransactionInput[],
  ): Promise<ynab.TransactionDetail[]> {
    this.assertWriteAllowed();
    const resolvedBudgetId = this.resolveBudgetId(budgetId);
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

    this.invalidateBudgetCache(resolvedBudgetId, [
      "accounts",
      "payees",
      "categories",
    ]);
    return response.data.transactions ?? [];
  }

  async deleteTransaction(
    budgetId: string | undefined,
    transactionId: string,
  ): Promise<ynab.TransactionDetail | null> {
    this.assertWriteAllowed();
    try {
      const resolvedBudgetId = this.resolveBudgetId(budgetId);
      const response = await this.api.transactions.deleteTransaction(
        resolvedBudgetId,
        transactionId,
      );
      this.invalidateBudgetCache(resolvedBudgetId, ["accounts", "categories"]);
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
      const resolvedBudgetId = this.resolveBudgetId(budgetId);
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
    const resolvedBudgetId = this.resolveBudgetId(budgetId);
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

    this.invalidateBudgetCache(resolvedBudgetId, [
      "scheduledTransactions",
      "payees",
      "categories",
    ]);

    return response.data.scheduled_transaction;
  }

  async updateScheduledTransaction(
    budgetId: string | undefined,
    transaction: UpdateScheduledTransactionInput,
    prefetchedExisting?: ynab.ScheduledTransactionDetail,
  ): Promise<ynab.ScheduledTransactionDetail> {
    this.assertWriteAllowed();
    const resolvedBudgetId = this.resolveBudgetId(budgetId);
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

    this.invalidateBudgetCache(resolvedBudgetId, [
      "scheduledTransactions",
      "payees",
      "categories",
    ]);

    return response.data.scheduled_transaction;
  }

  async deleteScheduledTransaction(
    budgetId: string | undefined,
    scheduledTransactionId: string,
  ): Promise<ynab.ScheduledTransactionDetail | null> {
    this.assertWriteAllowed();
    try {
      const resolvedBudgetId = this.resolveBudgetId(budgetId);
      const response =
        await this.api.scheduledTransactions.deleteScheduledTransaction(
          resolvedBudgetId,
          scheduledTransactionId,
        );

      this.invalidateBudgetCache(resolvedBudgetId, [
        "scheduledTransactions",
        "categories",
      ]);
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
    const resolvedBudgetId = this.resolveBudgetId(budgetId);
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

    this.invalidateBudgetCache(resolvedBudgetId, ["categories"]);
    return response.data.category;
  }

  async getMonthCategoryById(
    budgetId: string | undefined,
    month: string,
    categoryId: string,
  ): Promise<ynab.Category | null> {
    try {
      const resolvedBudgetId = this.resolveBudgetId(budgetId);
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
    const resolvedBudgetId = this.resolveBudgetId(budgetId);
    const response = await this.api.transactions.getTransactions(
      resolvedBudgetId,
      sinceDate,
    );

    const transactions = response.data.transactions;
    if (!untilDate) {
      return transactions.filter((t) => !t.deleted);
    }

    return transactions.filter((t) => !t.deleted && t.date <= untilDate);
  }

  private getBudgetCache(budgetId: string): BudgetCache {
    const existing = this.budgetCaches.get(budgetId);
    if (existing) {
      return existing;
    }

    const cache: BudgetCache = {
      accounts: { byId: new Map() },
      categories: { byId: new Map() },
      payees: { byId: new Map() },
      scheduledTransactions: { byId: new Map() },
      categoryGroups: new Map(),
      settings: undefined,
    };

    this.budgetCaches.set(budgetId, cache);
    return cache;
  }

  private invalidateBudgetCache(
    budgetId: string,
    keys: Array<"accounts" | "categories" | "payees" | "scheduledTransactions">,
  ): void {
    const cache = this.getBudgetCache(budgetId);

    for (const key of keys) {
      cache[key].byId.clear();
      cache[key].serverKnowledge = undefined;
      if (key === "categories") {
        cache.categoryGroups.clear();
      }
    }
  }

  private async refreshAccounts(budgetId: string): Promise<ynab.Account[]> {
    const cache = this.getBudgetCache(budgetId);
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

    return [...cache.accounts.byId.values()];
  }

  private async refreshCategories(
    budgetId: string,
  ): Promise<Array<ynab.CategoryGroupWithCategories>> {
    const cache = this.getBudgetCache(budgetId);
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

    return [...cache.categoryGroups.values()];
  }

  private async refreshPayees(budgetId: string): Promise<ynab.Payee[]> {
    const cache = this.getBudgetCache(budgetId);
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

    return [...cache.payees.byId.values()];
  }

  private async refreshScheduledTransactions(
    budgetId: string,
  ): Promise<ynab.ScheduledTransactionDetail[]> {
    const cache = this.getBudgetCache(budgetId);
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

    return [...cache.scheduledTransactions.byId.values()];
  }

  private async getTransactionsFromBestEndpoint(
    budgetId: string,
    query: TransactionSearchQuery,
  ): Promise<ynab.TransactionDetail[]> {
    if (query.account_id) {
      const response = await this.api.transactions.getTransactionsByAccount(
        budgetId,
        query.account_id,
        query.since_date,
        query.type,
      );
      return response.data.transactions;
    }

    if (query.category_id) {
      const response = await this.api.transactions.getTransactionsByCategory(
        budgetId,
        query.category_id,
        query.since_date,
        query.type,
      );

      return this.normalizeHybridTransactions(response.data.transactions);
    }

    if (query.payee_id) {
      const response = await this.api.transactions.getTransactionsByPayee(
        budgetId,
        query.payee_id,
        query.since_date,
        query.type,
      );

      return this.normalizeHybridTransactions(response.data.transactions);
    }

    const response = await this.api.transactions.getTransactions(
      budgetId,
      query.since_date,
      query.type,
    );

    return response.data.transactions;
  }

  private normalizeHybridTransactions(
    transactions: ynab.HybridTransaction[],
  ): ynab.TransactionDetail[] {
    // Parent hybrid transactions (type !== "subtransaction") are structurally
    // identical to TransactionDetail at runtime, but the SDK types don't
    // reflect this — HybridTransaction lacks the `subtransactions` array field.
    return transactions
      .filter((item) => item.type !== "subtransaction")
      .map(
        (item) =>
          ({
            ...item,
            subtransactions: [],
          }) as unknown as ynab.TransactionDetail,
      );
  }
}
