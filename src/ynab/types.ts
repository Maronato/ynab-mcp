export type TransactionFilterType = "uncategorized" | "unapproved";

export type TransactionSort = "date_asc" | "date_desc";

export type TransactionClearedStatus = "cleared" | "uncleared" | "reconciled";

export type ScheduledFrequency =
  | "never"
  | "daily"
  | "weekly"
  | "everyOtherWeek"
  | "twiceAMonth"
  | "every4Weeks"
  | "monthly"
  | "everyOtherMonth"
  | "every3Months"
  | "every4Months"
  | "twiceAYear"
  | "yearly"
  | "everyOtherYear";

export interface TransactionSearchQuery {
  since_date?: string;
  until_date?: string;
  account_id?: string;
  category_id?: string;
  payee_id?: string;
  amount_min?: number;
  amount_max?: number;
  memo_contains?: string;
  payee_name_contains?: string;
  category_name_contains?: string;
  flag_color?: string;
  exclude_transfers?: boolean;
  type?: TransactionFilterType;
  cleared?: TransactionClearedStatus;
  approved?: boolean;
  limit?: number;
  sort?: TransactionSort;
}

export interface SubtransactionInput {
  amount: number;
  payee_id?: string | null;
  payee_name?: string | null;
  category_id?: string | null;
  memo?: string | null;
}

export interface CreateTransactionInput {
  account_id: string;
  date: string;
  amount: number;
  payee_name?: string | null;
  payee_id?: string | null;
  category_id?: string | null;
  memo?: string | null;
  cleared?: TransactionClearedStatus;
  approved?: boolean;
  flag_color?: string | null;
  subtransactions?: SubtransactionInput[];
}

export interface UpdateTransactionInput {
  transaction_id: string;
  account_id?: string;
  date?: string;
  amount?: number;
  payee_name?: string | null;
  payee_id?: string | null;
  category_id?: string | null;
  memo?: string | null;
  cleared?: TransactionClearedStatus;
  approved?: boolean;
  flag_color?: string | null;
  subtransactions?: SubtransactionInput[];
}

export interface CategoryBudgetAssignment {
  category_id: string;
  month: string;
  budgeted: number;
}

export interface CreateScheduledTransactionInput {
  account_id: string;
  date: string;
  amount?: number;
  payee_name?: string | null;
  payee_id?: string | null;
  category_id?: string | null;
  memo?: string | null;
  frequency: ScheduledFrequency;
  flag_color?: string | null;
}

export interface UpdateScheduledTransactionInput {
  scheduled_transaction_id: string;
  account_id?: string;
  date?: string;
  amount?: number;
  payee_name?: string | null;
  payee_id?: string | null;
  category_id?: string | null;
  memo?: string | null;
  frequency?: ScheduledFrequency;
  flag_color?: string | null;
}

export interface FormattedMoney {
  amount: number;
  display: string;
}

export interface CategoryLookupEntry {
  name: string;
  group_id: string;
  group_name: string;
}

export interface NameLookup {
  accountById: Map<string, string>;
  categoryById: Map<string, CategoryLookupEntry>;
  payeeById: Map<string, string>;
}

export interface TransactionSnapshot {
  id: string;
  account_id: string;
  date: string;
  amount: number;
  payee_id?: string | null;
  category_id?: string | null;
  memo?: string | null;
  cleared: string;
  approved: boolean;
  flag_color?: string | null;
}

export interface ScheduledTransactionSnapshot {
  id: string;
  account_id: string;
  date: string;
  amount: number;
  payee_id?: string | null;
  category_id?: string | null;
  memo?: string | null;
  frequency?: string;
  flag_color?: string | null;
}
