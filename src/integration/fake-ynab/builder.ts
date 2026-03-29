/**
 * Fluent builder for populating FakeYnabState with test data.
 */

import * as crypto from "node:crypto";
import type {
  AccountData,
  CategoryData,
  CategoryGroupData,
  FakeYnabState,
  MonthDetailData,
  PayeeData,
  ScheduledTransactionData,
  SubTransactionData,
  TransactionData,
} from "./state.js";

export class FakeBudgetBuilder {
  private readonly accountsMap: Map<string, AccountData>;
  private readonly categoryGroupsList: CategoryGroupData[];
  private readonly transactionsMap: Map<string, TransactionData>;
  private readonly scheduledTransactionsMap: Map<
    string,
    ScheduledTransactionData
  >;
  private readonly payeesMap: Map<string, PayeeData>;
  private readonly monthDetailsMap: Map<string, MonthDetailData>;
  private readonly monthCategoriesMap: Map<string, CategoryData>;

  constructor(
    private state: FakeYnabState,
    private planId: string,
  ) {
    state.ensurePlanMaps(planId);
    // Cache map references — ensurePlanMaps guarantees these exist
    this.accountsMap = state.accounts.get(planId) as Map<string, AccountData>;
    this.categoryGroupsList = state.categoryGroups.get(
      planId,
    ) as CategoryGroupData[];
    this.transactionsMap = state.transactions.get(planId) as Map<
      string,
      TransactionData
    >;
    this.scheduledTransactionsMap = state.scheduledTransactions.get(
      planId,
    ) as Map<string, ScheduledTransactionData>;
    this.payeesMap = state.payees.get(planId) as Map<string, PayeeData>;
    this.monthDetailsMap = state.monthDetails.get(planId) as Map<
      string,
      MonthDetailData
    >;
    this.monthCategoriesMap = state.monthCategories.get(planId) as Map<
      string,
      CategoryData
    >;
  }

  withSettings(settings: {
    name?: string;
    iso_code?: string;
    example_format?: string;
    decimal_digits?: number;
    decimal_separator?: string;
    symbol_first?: boolean;
    group_separator?: string;
    currency_symbol?: string;
    display_symbol?: boolean;
  }): this {
    const currencyFormat = {
      iso_code: settings.iso_code ?? "USD",
      example_format: settings.example_format ?? "123,456.78",
      decimal_digits: settings.decimal_digits ?? 2,
      decimal_separator: settings.decimal_separator ?? ".",
      symbol_first: settings.symbol_first ?? true,
      group_separator: settings.group_separator ?? ",",
      currency_symbol: settings.currency_symbol ?? "$",
      display_symbol: settings.display_symbol ?? true,
    };
    this.state.plans.set(this.planId, {
      id: this.planId,
      name: settings.name ?? "My Budget",
      last_modified_on: null,
      first_month: null,
      last_month: null,
      date_format: null,
      currency_format: currencyFormat,
      settings: {
        date_format: { format: "MM/DD/YYYY" },
        currency_format: currencyFormat,
      },
    });
    return this;
  }

  withAccount(
    id: string,
    data: {
      name: string;
      type?: string;
      on_budget?: boolean;
      balance?: number;
      closed?: boolean;
    },
  ): this {
    const balance = data.balance ?? 0;
    this.accountsMap.set(id, {
      id,
      name: data.name,
      type: data.type ?? "checking",
      on_budget: data.on_budget ?? true,
      closed: data.closed ?? false,
      note: null,
      balance,
      cleared_balance: balance,
      uncleared_balance: 0,
      transfer_payee_id: `transfer:${id}`,
      direct_import_linked: null,
      direct_import_in_error: null,
      last_reconciled_at: null,
      debt_original_balance: null,
      debt_interest_rates: null,
      debt_minimum_payments: null,
      debt_escrow_amounts: null,
      deleted: false,
    });
    return this;
  }

  withCategoryGroup(
    id: string,
    name: string,
    categories: Array<
      {
        id: string;
        name: string;
        budgeted?: number;
        activity?: number;
        balance?: number;
        hidden?: boolean;
      } & Record<string, unknown>
    >,
  ): this {
    const cats: CategoryData[] = categories.map((c) => {
      const budgeted = (c.budgeted as number) ?? 0;
      const activity = (c.activity as number) ?? 0;
      const balance = c.balance ?? budgeted + activity;
      return {
        id: c.id,
        category_group_id: id,
        category_group_name: name,
        name: c.name,
        hidden: c.hidden ?? false,
        original_category_group_id: null,
        note: null,
        budgeted,
        activity,
        balance,
        goal_type: null,
        goal_needs_whole_amount: null,
        goal_day: null,
        goal_cadence: null,
        goal_cadence_frequency: null,
        goal_creation_month: null,
        goal_target: null,
        goal_target_month: null,
        goal_target_date: null,
        goal_percentage_complete: null,
        goal_months_to_budget: null,
        goal_under_funded: null,
        goal_overall_funded: null,
        goal_overall_left: null,
        goal_snoozed_at: null,
        deleted: false,
      };
    });
    const group: CategoryGroupData = {
      id,
      name,
      hidden: false,
      deleted: false,
      categories: cats,
    };
    this.categoryGroupsList.push(group);
    return this;
  }

  withPayee(id: string, name: string, transferAccountId?: string | null): this {
    const payee: PayeeData = {
      id,
      name,
      transfer_account_id: transferAccountId ?? null,
      deleted: false,
    };
    this.payeesMap.set(id, payee);
    return this;
  }

  withTransaction(
    id: string,
    data: {
      account_id: string;
      amount: number;
      date?: string;
      payee_id?: string | null;
      category_id?: string | null;
      memo?: string | null;
      cleared?: "cleared" | "uncleared" | "reconciled";
      approved?: boolean;
      subtransactions?: Array<{
        amount: number;
        category_id?: string | null;
        memo?: string | null;
        payee_id?: string | null;
      }>;
    },
  ): this {
    const subs: SubTransactionData[] = (data.subtransactions ?? []).map(
      (s) => ({
        id: `sub-${crypto.randomUUID()}`,
        transaction_id: id,
        amount: s.amount,
        memo: s.memo ?? null,
        payee_id: s.payee_id ?? null,
        payee_name: this.state.resolvePayeeName(
          this.planId,
          s.payee_id ?? null,
        ),
        category_id: s.category_id ?? null,
        category_name: this.state.resolveCategoryName(
          this.planId,
          s.category_id ?? null,
        ),
        transfer_account_id: null,
        transfer_transaction_id: null,
        deleted: false,
      }),
    );

    const tx: TransactionData = {
      id,
      date: data.date ?? "2024-01-01",
      amount: data.amount,
      memo: data.memo ?? null,
      cleared: data.cleared ?? "uncleared",
      approved: data.approved ?? true,
      flag_color: null,
      flag_name: null,
      account_id: data.account_id,
      payee_id: data.payee_id ?? null,
      category_id: data.category_id ?? null,
      transfer_account_id: null,
      transfer_transaction_id: null,
      matched_transaction_id: null,
      import_id: null,
      import_payee_name: null,
      import_payee_name_original: null,
      debt_transaction_type: null,
      deleted: false,
      account_name: this.state.resolveAccountName(this.planId, data.account_id),
      payee_name: this.state.resolvePayeeName(
        this.planId,
        data.payee_id ?? null,
      ),
      category_name: this.state.resolveCategoryName(
        this.planId,
        data.category_id ?? null,
      ),
      subtransactions: subs,
    };
    this.transactionsMap.set(id, tx);
    return this;
  }

  withScheduledTransaction(
    id: string,
    data: {
      account_id: string;
      amount: number;
      date_first?: string;
      date_next?: string;
      frequency?: string;
      payee_id?: string | null;
      category_id?: string | null;
      memo?: string | null;
    },
  ): this {
    const stx: ScheduledTransactionData = {
      id,
      date_first: data.date_first ?? "2024-01-01",
      date_next: data.date_next ?? "2024-04-01",
      frequency: data.frequency ?? "monthly",
      amount: data.amount,
      memo: data.memo ?? null,
      flag_color: null,
      flag_name: null,
      account_id: data.account_id,
      payee_id: data.payee_id ?? null,
      category_id: data.category_id ?? null,
      transfer_account_id: null,
      deleted: false,
      account_name: this.state.resolveAccountName(this.planId, data.account_id),
      payee_name: this.state.resolvePayeeName(
        this.planId,
        data.payee_id ?? null,
      ),
      category_name: this.state.resolveCategoryName(
        this.planId,
        data.category_id ?? null,
      ),
      subtransactions: [],
    };
    this.scheduledTransactionsMap.set(id, stx);
    return this;
  }

  withMonth(
    month: string,
    data: {
      income?: number;
      budgeted?: number;
      activity?: number;
      to_be_budgeted?: number;
      age_of_money?: number | null;
    },
  ): this {
    // Build categories from all groups, merged with monthCategory overrides
    const allCategories: CategoryData[] = [];
    const groups = this.categoryGroupsList;
    const monthCats = this.monthCategoriesMap;
    for (const group of groups) {
      for (const cat of group.categories) {
        const key = `${month}::${cat.id}`;
        const override = monthCats.get(key);
        allCategories.push(override ? { ...cat, ...override } : { ...cat });
      }
    }

    const detail: MonthDetailData = {
      month,
      note: null,
      income: data.income ?? 0,
      budgeted: data.budgeted ?? 0,
      activity: data.activity ?? 0,
      to_be_budgeted: data.to_be_budgeted ?? 0,
      age_of_money: data.age_of_money ?? null,
      deleted: false,
      categories: allCategories,
    };
    this.monthDetailsMap.set(month, detail);
    return this;
  }

  withMonthCategory(
    month: string,
    categoryId: string,
    data: { budgeted?: number; activity?: number; balance?: number },
  ): this {
    const baseCat = this.state.findCategoryById(this.planId, categoryId);
    const budgeted = data.budgeted ?? baseCat?.budgeted ?? 0;
    const activity = data.activity ?? baseCat?.activity ?? 0;
    const balance = data.balance ?? budgeted + activity;

    const merged: CategoryData = {
      ...(baseCat ?? {
        id: categoryId,
        category_group_id: "",
        category_group_name: null,
        name: "",
        hidden: false,
        original_category_group_id: null,
        note: null,
        budgeted: 0,
        activity: 0,
        balance: 0,
        goal_type: null,
        goal_needs_whole_amount: null,
        goal_day: null,
        goal_cadence: null,
        goal_cadence_frequency: null,
        goal_creation_month: null,
        goal_target: null,
        goal_target_month: null,
        goal_target_date: null,
        goal_percentage_complete: null,
        goal_months_to_budget: null,
        goal_under_funded: null,
        goal_overall_funded: null,
        goal_overall_left: null,
        goal_snoozed_at: null,
        deleted: false,
      }),
      budgeted,
      activity,
      balance,
    };

    const key = `${month}::${categoryId}`;
    this.monthCategoriesMap.set(key, merged);
    return this;
  }

  build(): void {
    // Ensure plan entry exists if withSettings was not called
    if (!this.state.plans.has(this.planId)) {
      this.withSettings({});
    }

    // Reset state so test starts fresh
    this.state.serverKnowledge = 1;
    this.state.changeLog.length = 0;
  }
}
