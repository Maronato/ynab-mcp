/**
 * In-memory state container for the fake YNAB API.
 * One instance per test — provides full isolation.
 */

// ── Entity data types matching YNAB SDK response shapes ──

export interface CurrencyFormatData {
  iso_code: string;
  example_format: string;
  decimal_digits: number;
  decimal_separator: string;
  symbol_first: boolean;
  group_separator: string;
  currency_symbol: string;
  display_symbol: boolean;
}

export interface DateFormatData {
  format: string;
}

export interface PlanSettingsData {
  date_format: DateFormatData;
  currency_format: CurrencyFormatData;
}

export interface PlanData {
  id: string;
  name: string;
  last_modified_on: string | null;
  first_month: string | null;
  last_month: string | null;
  date_format: DateFormatData | null;
  currency_format: CurrencyFormatData | null;
  settings: PlanSettingsData;
}

export interface AccountData {
  id: string;
  name: string;
  type: string;
  on_budget: boolean;
  closed: boolean;
  note: string | null;
  balance: number;
  cleared_balance: number;
  uncleared_balance: number;
  transfer_payee_id: string;
  direct_import_linked: boolean | null;
  direct_import_in_error: boolean | null;
  last_reconciled_at: string | null;
  debt_original_balance: number | null;
  debt_interest_rates: Record<string, number> | null;
  debt_minimum_payments: Record<string, number> | null;
  debt_escrow_amounts: Record<string, number> | null;
  deleted: boolean;
}

export interface CategoryData {
  id: string;
  category_group_id: string;
  category_group_name: string | null;
  name: string;
  hidden: boolean;
  original_category_group_id: string | null;
  note: string | null;
  budgeted: number;
  activity: number;
  balance: number;
  goal_type: string | null;
  goal_needs_whole_amount: boolean | null;
  goal_day: number | null;
  goal_cadence: number | null;
  goal_cadence_frequency: number | null;
  goal_creation_month: string | null;
  goal_target: number | null;
  goal_target_month: string | null;
  goal_target_date: string | null;
  goal_percentage_complete: number | null;
  goal_months_to_budget: number | null;
  goal_under_funded: number | null;
  goal_overall_funded: number | null;
  goal_overall_left: number | null;
  goal_snoozed_at: string | null;
  deleted: boolean;
}

export interface CategoryGroupData {
  id: string;
  name: string;
  hidden: boolean;
  deleted: boolean;
  categories: CategoryData[];
}

export interface PayeeData {
  id: string;
  name: string;
  transfer_account_id: string | null;
  deleted: boolean;
}

export interface SubTransactionData {
  id: string;
  transaction_id: string;
  amount: number;
  memo: string | null;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  category_name: string | null;
  transfer_account_id: string | null;
  transfer_transaction_id: string | null;
  deleted: boolean;
}

export interface TransactionData {
  id: string;
  date: string;
  amount: number;
  memo: string | null;
  cleared: "cleared" | "uncleared" | "reconciled";
  approved: boolean;
  flag_color: string | null;
  flag_name: string | null;
  account_id: string;
  payee_id: string | null;
  category_id: string | null;
  transfer_account_id: string | null;
  transfer_transaction_id: string | null;
  matched_transaction_id: string | null;
  import_id: string | null;
  import_payee_name: string | null;
  import_payee_name_original: string | null;
  debt_transaction_type: string | null;
  deleted: boolean;
  account_name: string;
  payee_name: string | null;
  category_name: string | null;
  subtransactions: SubTransactionData[];
}

export interface ScheduledSubTransactionData {
  id: string;
  scheduled_transaction_id: string;
  amount: number;
  memo: string | null;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  category_name: string | null;
  transfer_account_id: string | null;
  deleted: boolean;
}

export interface ScheduledTransactionData {
  id: string;
  date_first: string;
  date_next: string;
  frequency: string;
  amount: number;
  memo: string | null;
  flag_color: string | null;
  flag_name: string | null;
  account_id: string;
  payee_id: string | null;
  category_id: string | null;
  transfer_account_id: string | null;
  deleted: boolean;
  account_name: string;
  payee_name: string | null;
  category_name: string | null;
  subtransactions: ScheduledSubTransactionData[];
}

export interface MonthDetailData {
  month: string;
  note: string | null;
  income: number;
  budgeted: number;
  activity: number;
  to_be_budgeted: number;
  age_of_money: number | null;
  deleted: boolean;
  categories: CategoryData[];
}

export interface ChangeLogEntry {
  sk: number;
  planId: string;
  collection: string;
  entityId: string;
}

// ── Route handler interface ──

export interface RouteResult {
  status: number;
  body: unknown;
}

export type RouteParams = Record<string, string>;
export type QueryParams = Record<string, string>;

// ── State container ──

export class FakeYnabState {
  serverKnowledge = 1;

  readonly plans = new Map<string, PlanData>();
  /** planId → accountId → AccountData */
  readonly accounts = new Map<string, Map<string, AccountData>>();
  /** planId → CategoryGroupData[] */
  readonly categoryGroups = new Map<string, CategoryGroupData[]>();
  /** planId → txId → TransactionData */
  readonly transactions = new Map<string, Map<string, TransactionData>>();
  /** planId → stxId → ScheduledTransactionData */
  readonly scheduledTransactions = new Map<
    string,
    Map<string, ScheduledTransactionData>
  >();
  /** planId → payeeId → PayeeData */
  readonly payees = new Map<string, Map<string, PayeeData>>();
  /** planId → month → MonthDetailData */
  readonly monthDetails = new Map<string, Map<string, MonthDetailData>>();
  /** planId → "month::catId" → CategoryData */
  readonly monthCategories = new Map<string, Map<string, CategoryData>>();

  readonly changeLog: ChangeLogEntry[] = [];

  /** Record a mutation — increments serverKnowledge and appends to changeLog. */
  recordChange(planId: string, collection: string, entityId: string): void {
    this.serverKnowledge++;
    this.changeLog.push({
      sk: this.serverKnowledge,
      planId,
      collection,
      entityId,
    });
  }

  /** Get entity IDs changed since a given server_knowledge value. */
  getChangedEntityIds(
    planId: string,
    collection: string,
    sinceKnowledge: number,
  ): Set<string> {
    const ids = new Set<string>();
    for (const entry of this.changeLog) {
      if (
        entry.planId === planId &&
        entry.collection === collection &&
        entry.sk > sinceKnowledge
      ) {
        ids.add(entry.entityId);
      }
    }
    return ids;
  }

  /** Resolve an account name by ID, returns empty string if not found. */
  resolveAccountName(planId: string, accountId: string): string {
    return this.accounts.get(planId)?.get(accountId)?.name ?? "";
  }

  /** Resolve a payee name by ID, returns null if not found. */
  resolvePayeeName(planId: string, payeeId: string | null): string | null {
    if (!payeeId) return null;
    return this.payees.get(planId)?.get(payeeId)?.name ?? null;
  }

  /** Resolve a category name by ID, returns null if not found. */
  resolveCategoryName(
    planId: string,
    categoryId: string | null,
  ): string | null {
    if (!categoryId) return null;
    return this.findCategoryById(planId, categoryId)?.name ?? null;
  }

  /** Find a category across all groups for a plan. */
  findCategoryById(planId: string, categoryId: string): CategoryData | null {
    const groups = this.categoryGroups.get(planId);
    if (!groups) return null;
    for (const group of groups) {
      for (const cat of group.categories) {
        if (cat.id === categoryId) return cat;
      }
    }
    return null;
  }

  /** Ensure per-plan maps exist for a given planId. */
  ensurePlanMaps(planId: string): void {
    if (!this.accounts.has(planId)) this.accounts.set(planId, new Map());
    if (!this.categoryGroups.has(planId)) this.categoryGroups.set(planId, []);
    if (!this.transactions.has(planId))
      this.transactions.set(planId, new Map());
    if (!this.scheduledTransactions.has(planId))
      this.scheduledTransactions.set(planId, new Map());
    if (!this.payees.has(planId)) this.payees.set(planId, new Map());
    if (!this.monthDetails.has(planId))
      this.monthDetails.set(planId, new Map());
    if (!this.monthCategories.has(planId))
      this.monthCategories.set(planId, new Map());
  }
}
