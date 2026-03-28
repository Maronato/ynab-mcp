import type {
  NameLookup,
  ScheduledTransactionSnapshot,
  TransactionSnapshot,
} from "./types.js";

/** Branded numeric type representing amounts in milliunits (1/1000 of a currency unit). */
export type Milliunits = number & { readonly __brand: "milliunits" };

/** Branded numeric type representing amounts in currency units (e.g. dollars). */
export type CurrencyUnits = number & { readonly __brand: "currency" };

export interface CurrencyFormatLike {
  currency_symbol?: string;
  decimal_digits?: number;
  decimal_separator?: string;
  group_separator?: string;
  symbol_first?: boolean;
  display_symbol?: boolean;
}

/** Cast a raw number (from YNAB API) to Milliunits. Use at API boundaries only. */
export function asMilliunits(value: number): Milliunits {
  return value as Milliunits;
}

/** Cast a raw number (from user input) to CurrencyUnits. Use at API boundaries only. */
export function asCurrency(value: number): CurrencyUnits {
  return value as CurrencyUnits;
}

export function currencyToMilliunits(amount: CurrencyUnits): Milliunits {
  return Math.round((amount as number) * 1000) as Milliunits;
}

export function milliunitsToCurrency(amount: Milliunits): CurrencyUnits {
  return (Math.round(amount as number) / 1000) as CurrencyUnits;
}

export function formatCurrency(
  amountMilliunits: Milliunits,
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
  payee_name?: string | null;
  category_id?: string | null;
  memo?: string | null;
  cleared: string;
  approved: boolean;
  flag_color?: string | null;
  subtransactions?: Array<{
    amount: number;
    payee_id?: string | null;
    category_id?: string | null;
    memo?: string | null;
    deleted?: boolean;
  }>;
}): TransactionSnapshot {
  const activeSubs = transaction.subtransactions?.filter((s) => !s.deleted);
  return {
    id: transaction.id,
    account_id: transaction.account_id,
    date: transaction.date,
    amount: asMilliunits(transaction.amount),
    payee_id: transaction.payee_id ?? null,
    payee_name: transaction.payee_name ?? null,
    category_id: transaction.category_id ?? null,
    memo: transaction.memo ?? null,
    cleared: transaction.cleared,
    approved: transaction.approved,
    flag_color: transaction.flag_color ?? null,
    ...(activeSubs &&
      activeSubs.length > 0 && {
        subtransactions: activeSubs
          .map((sub) => ({
            amount: asMilliunits(sub.amount),
            payee_id: sub.payee_id ?? null,
            category_id: sub.category_id ?? null,
            memo: sub.memo ?? null,
          }))
          .sort((a, b) => {
            const catCmp = (a.category_id ?? "").localeCompare(
              b.category_id ?? "",
            );
            if (catCmp !== 0) return catCmp;
            const amountCmp = a.amount - b.amount;
            if (amountCmp !== 0) return amountCmp;
            const payeeCmp = (a.payee_id ?? "").localeCompare(b.payee_id ?? "");
            if (payeeCmp !== 0) return payeeCmp;
            return (a.memo ?? "").localeCompare(b.memo ?? "");
          }),
      }),
  };
}

export function snapshotScheduledTransaction(transaction: {
  id: string;
  account_id: string;
  date_first: string;
  amount: number;
  payee_id?: string | null;
  payee_name?: string | null;
  category_id?: string | null;
  memo?: string | null;
  frequency?: string;
  flag_color?: string | null;
}): ScheduledTransactionSnapshot {
  return {
    id: transaction.id,
    account_id: transaction.account_id,
    date: transaction.date_first,
    amount: asMilliunits(transaction.amount),
    payee_id: transaction.payee_id ?? null,
    payee_name: transaction.payee_name ?? null,
    category_id: transaction.category_id ?? null,
    memo: transaction.memo ?? null,
    frequency: transaction.frequency,
    flag_color: transaction.flag_color ?? null,
  };
}

export interface SubtransactionLike {
  id: string;
  amount: Milliunits;
  memo?: string | null;
  payee_id?: string | null;
  payee_name?: string | null;
  category_id?: string | null;
  category_name?: string | null;
  deleted: boolean;
}

export function formatTransactionForOutput(
  transaction: {
    id: string;
    date: string;
    amount: Milliunits;
    memo?: string | null;
    cleared: string;
    approved: boolean;
    account_id: string;
    payee_id?: string | null;
    category_id?: string | null;
    flag_color?: string | null;
    subtransactions?: SubtransactionLike[];
  },
  lookups: NameLookup,
  currencyFormat?: CurrencyFormatLike,
) {
  const subs = transaction.subtransactions?.filter((s) => !s.deleted) ?? [];
  const isSplit = subs.length > 0;

  return {
    id: transaction.id,
    date: transaction.date,
    amount: milliunitsToCurrency(transaction.amount),
    amount_display: formatCurrency(transaction.amount, currencyFormat),
    memo: transaction.memo ?? null,
    cleared: transaction.cleared,
    approved: transaction.approved,
    flag_color: transaction.flag_color ?? null,
    is_split: isSplit,
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
    ...(isSplit && {
      subtransactions: subs.map((sub) => {
        const catInfo = sub.category_id
          ? lookups.categoryById.get(sub.category_id)
          : undefined;
        return {
          id: sub.id,
          amount: milliunitsToCurrency(sub.amount),
          amount_display: formatCurrency(sub.amount, currencyFormat),
          memo: sub.memo ?? null,
          payee_id: sub.payee_id ?? null,
          payee_name: sub.payee_id
            ? (lookups.payeeById.get(sub.payee_id) ?? sub.payee_name ?? null)
            : (sub.payee_name ?? null),
          category_id: sub.category_id ?? null,
          category_name: sub.category_id
            ? (catInfo?.name ?? sub.category_name ?? null)
            : null,
          category_group_id: catInfo?.group_id ?? null,
          category_group_name: catInfo?.group_name ?? null,
        };
      }),
    }),
  };
}

export function formatScheduledTransactionForOutput(
  transaction: {
    id: string;
    date_first: string;
    date_next: string;
    frequency: string;
    amount: Milliunits;
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
