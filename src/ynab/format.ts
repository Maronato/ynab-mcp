import type { NameLookup } from "./types.js";

export interface CurrencyFormatLike {
  currency_symbol?: string;
  decimal_digits?: number;
  decimal_separator?: string;
  group_separator?: string;
  symbol_first?: boolean;
  display_symbol?: boolean;
}

export function currencyToMilliunits(amount: number): number {
  return Math.round(amount * 1000);
}

export function milliunitsToCurrency(amount: number): number {
  return amount / 1000;
}

export function formatCurrency(
  amountMilliunits: number,
  currencyFormat?: CurrencyFormatLike,
): string {
  const amount = milliunitsToCurrency(amountMilliunits);
  const absolute = Math.abs(amount);
  const decimalDigits = currencyFormat?.decimal_digits ?? 2;
  const symbol = currencyFormat?.currency_symbol ?? "$";
  const symbolFirst = currencyFormat?.symbol_first ?? true;
  const showSymbol = currencyFormat?.display_symbol ?? true;
  const decimalSeparator = currencyFormat?.decimal_separator ?? ".";
  const groupSeparator = currencyFormat?.group_separator ?? ",";
  const sign = amount < 0 ? "-" : "";

  const [integerRaw, fractionRaw = ""] = absolute
    .toFixed(decimalDigits)
    .split(".");
  const integer = integerRaw.replace(/\B(?=(\d{3})+(?!\d))/g, groupSeparator);
  const fraction = decimalDigits > 0 ? `${decimalSeparator}${fractionRaw}` : "";
  const value = `${integer}${fraction}`;

  if (!showSymbol) {
    return `${sign}${value}`;
  }

  return symbolFirst ? `${sign}${symbol}${value}` : `${sign}${value}${symbol}`;
}

export function snapshotTransaction(transaction: {
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
}): Record<string, unknown> {
  return {
    id: transaction.id,
    account_id: transaction.account_id,
    date: transaction.date,
    amount: transaction.amount,
    payee_id: transaction.payee_id ?? null,
    category_id: transaction.category_id ?? null,
    memo: transaction.memo ?? null,
    cleared: transaction.cleared,
    approved: transaction.approved,
    flag_color: transaction.flag_color ?? null,
  };
}

export function snapshotScheduledTransaction(transaction: {
  id: string;
  account_id: string;
  date_first: string;
  amount: number;
  payee_id?: string | null;
  category_id?: string | null;
  memo?: string | null;
  frequency?: string;
  flag_color?: string | null;
}): Record<string, unknown> {
  return {
    id: transaction.id,
    account_id: transaction.account_id,
    date: transaction.date_first,
    amount: transaction.amount,
    payee_id: transaction.payee_id ?? null,
    category_id: transaction.category_id ?? null,
    memo: transaction.memo ?? null,
    frequency: transaction.frequency,
    flag_color: transaction.flag_color ?? null,
  };
}

export function formatTransactionForOutput(
  transaction: {
    id: string;
    date: string;
    amount: number;
    memo?: string | null;
    cleared: string;
    approved: boolean;
    account_id: string;
    payee_id?: string | null;
    category_id?: string | null;
    flag_color?: string | null;
  },
  lookups: NameLookup,
  currencyFormat?: CurrencyFormatLike,
) {
  return {
    id: transaction.id,
    date: transaction.date,
    amount: milliunitsToCurrency(transaction.amount),
    amount_display: formatCurrency(transaction.amount, currencyFormat),
    memo: transaction.memo ?? null,
    cleared: transaction.cleared,
    approved: transaction.approved,
    flag_color: transaction.flag_color ?? null,
    account_id: transaction.account_id,
    account_name: lookups.accountById.get(transaction.account_id) ?? null,
    payee_id: transaction.payee_id ?? null,
    payee_name: transaction.payee_id
      ? (lookups.payeeById.get(transaction.payee_id) ?? null)
      : null,
    category_id: transaction.category_id ?? null,
    category_name: transaction.category_id
      ? (lookups.categoryById.get(transaction.category_id)?.name ?? null)
      : null,
    category_group_id: transaction.category_id
      ? (lookups.categoryById.get(transaction.category_id)?.group_id ?? null)
      : null,
    category_group_name: transaction.category_id
      ? (lookups.categoryById.get(transaction.category_id)?.group_name ?? null)
      : null,
  };
}

export function formatScheduledTransactionForOutput(
  transaction: {
    id: string;
    date_first: string;
    date_next: string;
    frequency: string;
    amount: number;
    memo?: string | null;
    account_id: string;
    payee_id?: string | null;
    category_id?: string | null;
    flag_color?: string | null;
  },
  lookups: NameLookup,
  currencyFormat?: CurrencyFormatLike,
) {
  return {
    id: transaction.id,
    date_first: transaction.date_first,
    date_next: transaction.date_next,
    frequency: transaction.frequency,
    amount: milliunitsToCurrency(transaction.amount),
    amount_display: formatCurrency(transaction.amount, currencyFormat),
    memo: transaction.memo ?? null,
    flag_color: transaction.flag_color ?? null,
    account_id: transaction.account_id,
    account_name: lookups.accountById.get(transaction.account_id) ?? null,
    payee_id: transaction.payee_id ?? null,
    payee_name: transaction.payee_id
      ? (lookups.payeeById.get(transaction.payee_id) ?? null)
      : null,
    category_id: transaction.category_id ?? null,
    category_name: transaction.category_id
      ? (lookups.categoryById.get(transaction.category_id)?.name ?? null)
      : null,
    category_group_id: transaction.category_id
      ? (lookups.categoryById.get(transaction.category_id)?.group_id ?? null)
      : null,
    category_group_name: transaction.category_id
      ? (lookups.categoryById.get(transaction.category_id)?.group_name ?? null)
      : null,
  };
}
