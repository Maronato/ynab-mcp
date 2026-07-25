/**
 * Timezone-safe date helpers for YNAB's YYYY-MM-DD date strings.
 *
 * Rules enforced here:
 * - Never call toISOString() on a Date built from local-time components
 *   (it shifts across UTC midnight for non-UTC timezones).
 * - Never read local getters from a Date parsed from a "YYYY-MM-DD" string
 *   (string parsing yields UTC midnight; local getters shift it back a day
 *   in UTC-negative timezones).
 * All arithmetic is done on parsed components and formatted manually.
 */

/** Format a Date's LOCAL components as YYYY-MM-DD. */
export function localDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Today's date as YYYY-MM-DD in local time. */
export function todayString(): string {
  return localDateString(new Date());
}

/** First day of the current month as YYYY-MM-DD in local time. */
export function currentMonthString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

/** Parse "YYYY-MM-DD" (or "YYYY-MM") into numeric components. */
export function parseDateParts(dateStr: string): {
  year: number;
  month: number;
  day: number;
} {
  const [year, month, day] = dateStr.split("-").map(Number);
  return { year, month, day: day ?? 1 };
}

/** Number of days in the month containing the given YYYY-MM-DD date. */
export function daysInMonth(dateStr: string): number {
  const { year, month } = parseDateParts(dateStr);
  return new Date(year, month, 0).getDate();
}

/** Last day of the month containing the given YYYY-MM-DD date, as YYYY-MM-DD. */
export function endOfMonthString(dateStr: string): string {
  const { year, month } = parseDateParts(dateStr);
  const lastDay = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

/** First-of-month string shifted by delta months (delta may be negative). */
export function addMonthsToMonthString(
  monthStr: string,
  delta: number,
): string {
  const { year, month } = parseDateParts(monthStr);
  const shifted = new Date(year, month - 1 + delta, 1);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, "0")}-01`;
}

/**
 * YYYY-MM month keys for the last `count` months, oldest first, ending with
 * the current local month.
 */
export function monthKeysBack(count: number): string[] {
  const now = new Date();
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
    );
  }
  return keys;
}

/**
 * Date `months` months before today, as YYYY-MM-DD in local time.
 *
 * Clamps to the target month's last day instead of rolling over: plain
 * setMonth turns 2026-03-31 minus one month into 2026-03-03 (February has
 * no 31st), which silently shortens history windows.
 */
export function dateMonthsAgo(months: number): string {
  const now = new Date();
  const targetYear = now.getFullYear();
  const targetMonthIndex = now.getMonth() - months;
  const lastDayOfTarget = new Date(
    targetYear,
    targetMonthIndex + 1,
    0,
  ).getDate();
  const d = new Date(
    targetYear,
    targetMonthIndex,
    Math.min(now.getDate(), lastDayOfTarget),
  );
  return localDateString(d);
}

/** Date `days` days before today, as YYYY-MM-DD in local time. */
export function dateDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return localDateString(d);
}

/** Shift a YYYY-MM-DD string by a number of days (fractions are rounded). */
export function addDaysToDateString(dateStr: string, days: number): string {
  const { year, month, day } = parseDateParts(dateStr);
  const d = new Date(year, month - 1, day + Math.round(days));
  return localDateString(d);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  const pa = parseDateParts(a);
  const pb = parseDateParts(b);
  const msPerDay = 1000 * 60 * 60 * 24;
  // UTC timestamps of date-only values: immune to DST transitions.
  const ta = Date.UTC(pa.year, pa.month - 1, pa.day);
  const tb = Date.UTC(pb.year, pb.month - 1, pb.day);
  return Math.round((tb - ta) / msPerDay);
}

/** Day of week (0=Sunday..6=Saturday) for a YYYY-MM-DD string. */
export function dayOfWeek(dateStr: string): number {
  const { year, month, day } = parseDateParts(dateStr);
  return new Date(year, month - 1, day).getDay();
}

/** The Monday on or before the given YYYY-MM-DD date, as YYYY-MM-DD. */
export function mondayOfWeek(dateStr: string): string {
  const dow = dayOfWeek(dateStr);
  const diff = dow === 0 ? -6 : 1 - dow;
  return addDaysToDateString(dateStr, diff);
}
