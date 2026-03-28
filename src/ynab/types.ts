import type { Milliunits } from "./format.js";

export type TransactionFilterType = "uncategorized" | "unapproved";

export type TransactionSort = "date_asc" | "date_desc";

export type TransactionClearedStatus = "cleared" | "uncleared" | "reconciled";

// The YNAB API only accepts these five frequency values on create/update.
// Compound values (everyOtherWeek, twiceAMonth, etc.) exist in read
// responses for transactions created through the YNAB app but are
// rejected by the API on write operations.
export type ScheduledFrequency =
  | "never"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly";

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

export interface SubtransactionSnapshot {
  [key: string]: unknown;
  amount: Milliunits;
  payee_id: string | null;
  category_id: string | null;
  memo: string | null;
}

export interface TransactionSnapshot {
  [key: string]: unknown;
  id: string;
  account_id: string;
  date: string;
  amount: Milliunits;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  memo: string | null;
  cleared: string;
  approved: boolean;
  flag_color: string | null;
  subtransactions?: SubtransactionSnapshot[];
}

export interface ScheduledTransactionSnapshot {
  [key: string]: unknown;
  id: string;
  account_id: string;
  date: string;
  amount: Milliunits;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  memo: string | null;
  frequency?: string;
  flag_color: string | null;
}
