import type * as ynab from "ynab";
import { asCurrency, currencyToMilliunits } from "./format.js";
import type { TransactionSearchQuery } from "./types.js";

/**
 * Pure filter+sort over an in-memory transaction array.
 *
 * This is the core of {@link YnabClient.searchTransactions} extracted so it
 * can be tested and evolved independently of the client / cache layer.
 */
export function filterAndSortTransactions(
  transactions: ynab.TransactionDetail[],
  query: TransactionSearchQuery,
): ynab.TransactionDetail[] {
  const minimum =
    query.amount_min !== undefined
      ? currencyToMilliunits(asCurrency(query.amount_min))
      : undefined;
  const maximum =
    query.amount_max !== undefined
      ? currencyToMilliunits(asCurrency(query.amount_max))
      : undefined;
  const memoContains = query.memo_contains?.toLowerCase();
  const payeeNameContains = query.payee_name_contains?.toLowerCase();
  const categoryNameContains = query.category_name_contains?.toLowerCase();

  const filtered = transactions.filter((transaction) => {
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
      !(transaction.payee_name ?? "").toLowerCase().includes(payeeNameContains)
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

    if (query.cleared !== undefined && transaction.cleared !== query.cleared) {
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
