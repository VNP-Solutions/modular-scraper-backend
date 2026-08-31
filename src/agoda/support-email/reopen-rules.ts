/**
 * Decides, row by row, what to do with the report Agoda Partner Support
 * attached to its reply. Every row lands on one of three actions:
 *
 *   COLLECT — the amount is known and above the minimum, so the property can
 *             charge it directly.
 *   REOPEN  — the row is still owed but the amount cannot be determined, so the
 *             case has to go back to Agoda.
 *   SKIP    — nothing to do.
 *
 * Agoda sends two report layouts:
 *
 *   Type 1 `payment_status`         — has `Payment Status`; amount in `LP(USD)`.
 *   Type 2 `booking_matched_status` — has `Booking Matched Status Name`; amount
 *                                     in `USD Total Include GST`.
 *
 * The 150-day checkout cutoff is applied to both layouts before anything else.
 *
 * Header spelling, status casing and date formats all vary between exports, so
 * columns and status values are matched on a normalized form and dates are read
 * through a set of tolerant patterns rather than one fixed layout.
 */

import type {
  EvaluatedRow,
  ParsedAttachment,
  ReopenDecision,
  ReopenRuleOptions,
  RowAction,
  SheetType,
} from "./support-email.types.js";

// ============================================================
// Config
// ============================================================

/** Agoda stops accepting collection this long after checkout. */
export const CHECKOUT_DAYS_LIMIT = 150;

/** Below this amount it is not worth collecting. */
export const MIN_AMOUNT = 2;

/**
 * Column names in normalized form: lowercased with every separator removed.
 * `Check Out Date`, `Checkout Date`, `checkout_date` and `Check-out Date` all
 * collapse to `checkoutdate`, so one entry covers every spelling.
 */
const COLUMN_KEYS = {
  hotelId: ["hotelid", "propertyid", "hotelno"],
  bookingId: ["bookingid", "bookingno", "bookingnumber", "reservationid"],
  checkoutDate: [
    "checkoutdate",
    "checkout",
    "checkoutdt",
    "departuredate",
    "departure",
  ],
  paymentStatus: ["paymentstatus"],
  bookingStatus: ["bookingstatus"],
  matchedStatus: [
    "bookingmatchedstatusname",
    "bookingmatchedstatus",
    "matchedstatusname",
    "matchedstatus",
  ],
  /** Type 1 amount column: `LP(USD)` / `LP (USD)`. */
  type1Amount: ["lpusd", "lpusdamount"],
  /** Type 2 amount column: `USD Total Include GST`. */
  type2Amount: ["usdtotalincludegst", "usdtotalincludinggst", "usdtotal"],
} as const;

/** Matched statuses meaning the money has not been received yet. */
const UNPAID_MATCHED_STATUSES = ["open", "matchedunder", "matchunder"];

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// ============================================================
// Helpers
// ============================================================

/** Drops spaces, underscores, dashes and brackets so spellings can be compared. */
function normKey(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Lowercased, trimmed value — used for display in reasons. */
function norm(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Normalized status value, so `Cxl by Customer` and `cxl_by_customer` agree. */
function normStatus(value: unknown): string {
  return normKey(value);
}

/** Resolves the real header name for a logical column, or null if absent. */
function findColumn(
  headers: string[],
  keys: readonly string[]
): string | null {
  return headers.find((header) => keys.includes(normKey(header))) ?? null;
}

function cell(row: Record<string, string>, column: string | null): string {
  if (!column) return "";
  return (row[column] ?? "").trim();
}

/**
 * Excel applies the cell's number format to IDs, so a hotel or booking number
 * arrives as `6,377,849.00`. Strip the separators and the decimal tail so the
 * value is usable and comparable, leaving anything non-numeric untouched.
 */
export function cleanId(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (!/^[\d.,\s]+$/.test(text)) return text;
  return text.replace(/[,\s]/g, "").replace(/\.0+$/, "");
}

/** Reads `$1,234.56`, `USD 12.5`, `(12.50)` and plain numbers. */
export function parseAmount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  let text = String(value).trim();
  if (!text) return null;

  // Accounting notation: (12.50) means -12.50.
  const isNegative = /^\(.*\)$/.test(text);
  if (isNegative) text = text.slice(1, -1);

  text = text.replace(/[^0-9.-]/g, "");
  if (!text || text === "-" || text === ".") return null;

  const num = Number(text);
  if (!Number.isFinite(num)) return null;

  return isNegative ? -num : num;
}

/** Excel serial: days since 1899-12-30. */
function fromExcelSerial(serial: number): Date | null {
  if (serial <= 0) return null;
  const date = new Date(Math.round((serial - 25569) * 86400000));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Two-digit years: 00-69 are 2000s, 70-99 are 1900s. */
function expandYear(year: number): number {
  if (year >= 100) return year;
  return year < 70 ? 2000 + year : 1900 + year;
}

function monthFromName(name: string): number | null {
  return MONTHS[name.slice(0, 3).toLowerCase()] ?? null;
}

/**
 * Reads the date formats Agoda's exports use in practice:
 * `2026-04-26`, `2026-04-23T08:53:16`, `4/26/2026`, `4/26/26`, `26.04.2026`,
 * `April 21, 2026`, `21 Apr 2026`, Date objects and Excel serials.
 */
export function parseDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return fromExcelSerial(value);
  }

  const text = String(value).trim();
  if (!text) return null;

  // A serial that arrived as text, constrained to a plausible date range.
  if (/^\d{4,5}$/.test(text)) {
    const serial = Number(text);
    if (serial >= 20000 && serial <= 60000) return fromExcelSerial(serial);
  }

  let year: number;
  let month: number;
  let day: number;
  let match: RegExpExecArray | null;

  if ((match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/.exec(text))) {
    // ISO, tolerating a trailing time such as `2026-04-23T08:53:16`.
    year = +match[1];
    month = +match[2];
    day = +match[3];
  } else if ((match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?!\d)/.exec(text))) {
    // US month-first, with a two- or four-digit year.
    month = +match[1];
    day = +match[2];
    year = expandYear(+match[3]);

    // A first component above 12 can only be a day, so this is a day-first
    // export such as `26.04.2026`.
    if (month > 12 && day <= 12) {
      [month, day] = [day, month];
    }
  } else if ((match = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(text))) {
    // `April 21, 2026`
    const named = monthFromName(match[1]);
    if (named === null) return null;
    month = named;
    day = +match[2];
    year = +match[3];
  } else if ((match = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(text))) {
    // `21 April 2026`
    const named = monthFromName(match[2]);
    if (named === null) return null;
    day = +match[1];
    month = named;
    year = +match[3];
  } else {
    return null;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects rolled-over values such as 2026-02-31.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;

  return date;
}

function daysAgo(date: Date, now: Date): number {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const then = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  );
  return Math.floor((today - then) / 86400000);
}

interface RowVerdict {
  action: RowAction;
  amount: number | null;
  reason: string;
}

/**
 * Last step for both layouts once the status checks have passed: a readable
 * amount above the minimum is collectable, a blank one sends the case back.
 */
function finalizeAmount(rawAmount: unknown, reason: string): RowVerdict {
  const amount = parseAmount(rawAmount);

  if (amount === null) {
    return {
      action: "REOPEN",
      amount: null,
      reason: `${reason} (amount blank/unreadable)`,
    };
  }

  if (amount < MIN_AMOUNT) {
    return { action: "SKIP", amount, reason: `Amount ${amount} < ${MIN_AMOUNT}` };
  }

  return { action: "COLLECT", amount, reason };
}

// ============================================================
// Column resolution
// ============================================================

interface ResolvedColumns {
  hotelId: string | null;
  bookingId: string | null;
  checkoutDate: string | null;
  paymentStatus: string | null;
  bookingStatus: string | null;
  matchedStatus: string | null;
  amount: string | null;
}

export function resolveColumns(headers: string[]): ResolvedColumns {
  const matchedStatus = findColumn(headers, COLUMN_KEYS.matchedStatus);

  return {
    hotelId: findColumn(headers, COLUMN_KEYS.hotelId),
    bookingId: findColumn(headers, COLUMN_KEYS.bookingId),
    checkoutDate: findColumn(headers, COLUMN_KEYS.checkoutDate),
    paymentStatus: findColumn(headers, COLUMN_KEYS.paymentStatus),
    bookingStatus: findColumn(headers, COLUMN_KEYS.bookingStatus),
    matchedStatus,
    // Type 2 sheets carry the GST total; Type 1 sheets carry LP (USD).
    amount: matchedStatus
      ? findColumn(headers, COLUMN_KEYS.type2Amount)
      : findColumn(headers, COLUMN_KEYS.type1Amount),
  };
}

function detectSheetType(columns: ResolvedColumns): SheetType {
  if (columns.matchedStatus) return "booking_matched_status";
  if (columns.paymentStatus) return "payment_status";
  return "unknown";
}

// ============================================================
// Row decision
// ============================================================

export function decideAction(
  headers: string[],
  row: Record<string, string>,
  now: Date = new Date(),
  resolved?: ResolvedColumns
): RowVerdict {
  const columns = resolved ?? resolveColumns(headers);

  // ---------- 0. Drop anything past the 150-day checkout limit ----------
  // Applies to both layouts, so it runs before the type is even resolved.
  const checkoutDate = parseDate(cell(row, columns.checkoutDate));

  if (checkoutDate) {
    const age = daysAgo(checkoutDate, now);
    if (age > CHECKOUT_DAYS_LIMIT) {
      return {
        action: "SKIP",
        amount: null,
        reason: `Checkout ${age} days ago (limit ${CHECKOUT_DAYS_LIMIT})`,
      };
    }
  }
  // No checkout date, or unreadable — carry on with the normal flow.

  // ---------- Type 2: Agoda Matched Status report ----------
  // Matched / Matched-over → already paid → skip.
  // Open / Matched-under   → still owed:
  //     no amount column   → reopen
  //     amount column      → collect when >= MIN_AMOUNT, else skip
  if (columns.matchedStatus) {
    const raw = cell(row, columns.matchedStatus);

    if (!UNPAID_MATCHED_STATUSES.includes(normStatus(raw))) {
      return {
        action: "SKIP",
        amount: null,
        reason: `Matched status: ${norm(raw)}`,
      };
    }

    if (!columns.amount) {
      return {
        action: "REOPEN",
        amount: null,
        reason: "USD Total Include GST column missing",
      };
    }

    return finalizeAmount(cell(row, columns.amount), `Matched status: ${norm(raw)}`);
  }

  // ---------- Type 1: Payment Status report ----------
  // Paid → skip.
  // With a Booking Status column → needs Pending Collection + Departed.
  // Without one                  → Pending Collection alone is enough.
  // Then: no LP(USD) → reopen; otherwise collect when >= MIN_AMOUNT.
  if (columns.paymentStatus) {
    const rawPayment = cell(row, columns.paymentStatus);
    const paymentStatus = normStatus(rawPayment);

    if (paymentStatus === "paid") {
      return { action: "SKIP", amount: null, reason: "Already paid" };
    }

    if (columns.bookingStatus) {
      const rawBooking = cell(row, columns.bookingStatus);

      // Cxl by customer, or any other booking status, is not collectable.
      if (
        paymentStatus !== "pendingcollection" ||
        normStatus(rawBooking) !== "departed"
      ) {
        return {
          action: "SKIP",
          amount: null,
          reason: `${norm(rawPayment)} / ${norm(rawBooking)}`,
        };
      }
    } else if (paymentStatus !== "pendingcollection") {
      return {
        action: "SKIP",
        amount: null,
        reason: `Payment status: ${norm(rawPayment)}`,
      };
    }

    if (!columns.amount) {
      return { action: "REOPEN", amount: null, reason: "LP(USD) column missing" };
    }

    return finalizeAmount(
      cell(row, columns.amount),
      columns.bookingStatus
        ? "Pending collection + Departed"
        : "Pending collection (no booking status column)"
    );
  }

  return { action: "SKIP", amount: null, reason: "Unknown sheet type" };
}

// ============================================================
// Whole-attachment decision
// ============================================================

export function evaluateReopenDecision(
  attachment: ParsedAttachment,
  context: { agodaId?: string | null } = {},
  options: ReopenRuleOptions = {}
): ReopenDecision {
  const now = options.now ?? new Date();

  const headers =
    attachment.columns.length > 0
      ? attachment.columns
      : Object.keys(attachment.rows[0] ?? {});

  const columns = resolveColumns(headers);

  const decision: ReopenDecision = {
    sheetType: detectSheetType(columns),
    shouldReopen: false,
    collect: [],
    reopen: [],
    skipped: [],
    totalCollectAmountUsd: null,
    detectedColumns: { ...columns },
  };

  if (attachment.parseError || attachment.rows.length === 0) {
    return decision;
  }

  for (const row of attachment.rows) {
    const bookingId = cleanId(cell(row, columns.bookingId));
    const checkoutDate = cell(row, columns.checkoutDate) || null;
    const hotelId = cleanId(cell(row, columns.hotelId));

    const verdict =
      context.agodaId && hotelId && !sameId(hotelId, context.agodaId)
        ? {
            action: "SKIP" as RowAction,
            amount: null,
            reason: `Row hotel ID ${hotelId} does not match property Agoda ID ${context.agodaId}`,
          }
        : decideAction(headers, row, now, columns);

    const evaluated: EvaluatedRow = {
      bookingId,
      action: verdict.action,
      amount: verdict.amount,
      reason: verdict.reason,
      checkoutDate,
      row,
    };

    if (verdict.action === "COLLECT") decision.collect.push(evaluated);
    else if (verdict.action === "REOPEN") decision.reopen.push(evaluated);
    else decision.skipped.push(evaluated);
  }

  decision.shouldReopen = decision.reopen.length > 0;

  const amounts = decision.collect
    .map((entry) => entry.amount)
    .filter((amount): amount is number => amount !== null);

  decision.totalCollectAmountUsd =
    amounts.length > 0
      ? Number(amounts.reduce((sum, amount) => sum + amount, 0).toFixed(2))
      : null;

  return decision;
}

function sameId(left: string, right: string): boolean {
  const a = cleanId(left);
  const b = cleanId(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const numericA = Number(a);
  const numericB = Number(b);
  return (
    Number.isFinite(numericA) && Number.isFinite(numericB) && numericA === numericB
  );
}
