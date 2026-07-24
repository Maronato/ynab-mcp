/**
 * Classification of YNAB's system ("internal") category groups.
 *
 * Spec 1.85 added a required `internal` flag to categories and category
 * groups, which is locale-independent — unlike the English name matching
 * used before. The flag cannot be adopted blindly, though: live budgets
 * exist where user-created groups carry `internal: true` (verified against
 * the live API, spec 1.86, 2026-07), so the group-level flag alone would
 * misclassify real spending groups. Category-level `internal` was clean in
 * the same verification: only the true system categories ("Inflow: Ready
 * to Assign", "Uncategorized") carry it.
 *
 * A group therefore counts as a system group only when the flag is
 * corroborated by structure — it contains an internal category (the master
 * category group), or one of its categories is named after a credit-card
 * account (the credit-card payments group; YNAB keeps payment category
 * names in sync with their accounts). The English names remain as a
 * fallback for data sources that predate the flag.
 */

interface CategoryLike {
  name: string;
  internal?: boolean;
}

interface CategoryGroupLike {
  name: string;
  internal?: boolean;
  categories?: CategoryLike[];
}

const INTERNAL_MASTER_GROUP_NAME = "Internal Master Category";
const CREDIT_CARD_PAYMENTS_GROUP_NAME = "Credit Card Payments";

/**
 * Whether a category is one of YNAB's internal system categories
 * ("Inflow: Ready to Assign", "Uncategorized"). The category-level flag is
 * reliable; the group name is kept as a fallback for flag-less data.
 */
export function isInternalCategory(
  category: CategoryLike,
  groupName?: string,
): boolean {
  return category.internal === true || groupName === INTERNAL_MASTER_GROUP_NAME;
}

/** Whether a group is YNAB's master category group (inflow/uncategorized). */
export function isInternalMasterGroup(group: CategoryGroupLike): boolean {
  if (group.name === INTERNAL_MASTER_GROUP_NAME) return true;
  return (
    group.internal === true &&
    (group.categories ?? []).some((category) => category.internal === true)
  );
}

/**
 * Whether a group is YNAB's credit-card payments group. Payment categories
 * are not flagged internal themselves, so the corroborating signal is a
 * category named after a credit-card account (`creditAccountNames`).
 */
export function isCreditCardPaymentsGroup(
  group: CategoryGroupLike,
  creditAccountNames?: ReadonlySet<string>,
): boolean {
  if (group.name === CREDIT_CARD_PAYMENTS_GROUP_NAME) return true;
  if (group.internal !== true) return false;
  if (!creditAccountNames || creditAccountNames.size === 0) return false;
  return (group.categories ?? []).some((category) =>
    creditAccountNames.has(category.name),
  );
}

/**
 * Whether a group is one of YNAB's system groups (master category group or
 * credit-card payments group) that budgeting analyses should skip.
 */
export function isSystemCategoryGroup(
  group: CategoryGroupLike,
  creditAccountNames?: ReadonlySet<string>,
): boolean {
  return (
    isInternalMasterGroup(group) ||
    isCreditCardPaymentsGroup(group, creditAccountNames)
  );
}
