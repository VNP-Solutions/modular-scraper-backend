/**
 * Computes the three derived chargeback fields populated on every JobItem
 * document at insert time. The NestJS backend's lazy-refresh path
 * (`computeDerivedJobItemFields` in `src/module/job/job-item-derived.util.ts`)
 * uses the exact same rules — this file is the scraper-side mirror.
 *
 * RULES (kept in lockstep with backend):
 *   - Only Expedia rows ever get non-null values; Booking & Agoda → all null.
 *   - Whole-day diff, UTC-anchored on both sides (no DST artifacts).
 *   - `over_160` is strictly `> 160`, NOT `>=`.
 *   - `derived_calculated_at` is start-of-day UTC of "today" (the freshness
 *     anchor the backend reads).
 *   - Unparseable / missing check_out_date → all three null (backend will
 *     lazily compute on first read).
 */

import { OTAProvider } from "../models/job.model.js";

export interface DerivedJobItemFields {
  over_160: boolean | null;
  days_since_checkout: number | null;
  derived_calculated_at: Date | null;
}

const NULL_FIELDS: DerivedJobItemFields = {
  over_160: null,
  days_since_checkout: null,
  derived_calculated_at: null,
};

/**
 * Normalize the check-out date to a JS `Date` or null.
 * Accepts `Date`, ISO string, or anything `Date` can parse.
 */
function normalizeDate(input: unknown): Date | null {
  if (input == null) return null;
  if (input instanceof Date) {
    return isNaN(input.getTime()) ? null : input;
  }
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return null;
    const parsed = new Date(trimmed);
    return isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * Compute (over_160, days_since_checkout, derived_calculated_at) for a single
 * JobItem given its parent job's OTA provider and the item's check-out date.
 *
 * @param otaProvider Parent job's `ota_provider` (string or enum). Case-insensitive.
 * @param checkOutDate Item's check-out date. `Date` | ISO string | null/undefined.
 * @param now Optional injection point for "today" (defaults to current UTC).
 */
export function computeDerivedJobItemFields(
  otaProvider: OTAProvider | string | null | undefined,
  checkOutDate: Date | string | null | undefined,
  now: Date = new Date(),
): DerivedJobItemFields {
  // OTA gate — only Expedia rows ever get computed values.
  const provider = (otaProvider ?? "").toString().trim().toLowerCase();
  if (provider !== "expedia") {
    return { ...NULL_FIELDS };
  }

  const coDate = normalizeDate(checkOutDate);
  if (!coDate) {
    return { ...NULL_FIELDS };
  }

  // Whole-day UTC math: collapse both sides to a UTC midnight epoch and
  // divide by ms/day. This is equivalent to Python's `date(...) - date(...)`
  // and is immune to DST since UTC has no DST.
  const fromDayUtcMs = Date.UTC(
    coDate.getUTCFullYear(),
    coDate.getUTCMonth(),
    coDate.getUTCDate(),
  );
  const toDayUtcMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const MS_PER_DAY = 86_400_000;
  // Round to guard against any sub-ms float drift; result is a signed integer
  // (negative for future check-outs, matching the Python reference).
  const days = Math.round((toDayUtcMs - fromDayUtcMs) / MS_PER_DAY);

  return {
    over_160: days > 160,
    days_since_checkout: days,
    derived_calculated_at: new Date(toDayUtcMs),
  };
}
