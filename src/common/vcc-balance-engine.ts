/**
 * EPC Virtual Card — Remaining Balance Engine
 * ------------------------------------------------
 * Faithful re-implementation of the formula logic found in
 * "3 Reservation Verdicts" of EPC_VCC_Balance_Engine_WideFormat.xlsx
 *
 * INPUT (per reservation):
 *   {
 *     reservationId:    string,                 // Reservation ID (primary key)
 *     checkInDate:      string | Date,            // context only, not used in math
 *     checkoutDate:     string | Date,            // e.g. "18/8/2025" (D/M/YYYY), "28 July 2025",
 *                                                  // or an ISO string / Date object like
 *                                                  // "2026-07-31T00:00:00.000Z" — PREFERRED:
 *                                                  // when given, readyToChargeOn / chargeBy
 *                                                  // are auto-derived (checkout+7 / checkout+365)
 *     remainingBalance: string | number,          // just the value now, no currency prefix, e.g. "2.00" or 2
 *     bookingAmount:    string | number,          // just the value now, no currency prefix, e.g. "230.20" or 230.20
 *     readyToChargeOn:  string | Date | null,      // MANUAL fallback, only used if no checkoutDate given
 *     chargeBy:         string | Date | null,      // MANUAL fallback, only used if no checkoutDate given
 *     transactions: [                             // up to 46 blocks
 *       {
 *         authDate:   string,   // "DD/MM/YYYY" as it appears in the extract
 *         postedDate: string,   // "NA" / "" / a real date string
 *         authCode:   string,
 *         amount:     string | number,  // just the value now, no currency prefix, e.g. "228.20" / -228.20
 *         status:     string    // "Approved" / "Declined ..." / "NA"
 *       }, ...
 *     ]
 *   }
 *
 * FIELD NAMING: checkInDate/checkoutDate also accept the snake_case
 * equivalents check_in_date/check_out_date (e.g. straight from a
 * database or API payload like `{ check_in_date: Date, check_out_date: Date }`).
 * Both naming styles are read — whichever one is present on the object
 * wins. Every date value accepts a JS Date object, an ISO 8601 string
 * ("2026-07-28T00:00:00.000Z"), a "DD/MM/YYYY" string, or a spelled-out
 * date string ("28 July 2025") interchangeably.
 *
 * OUTPUT: see bottom of runEngine() — mirrors columns A-S + the key
 * hidden engine columns (U-AI) of tab "3 Reservation Verdicts".
 *
 * REUSABILITY NOTE FOR NEW DEVELOPERS:
 * This file is organized into small, independently testable "layers"
 * (Layer 0 through Layer 8). Every layer function is a pure function —
 * same input always gives the same output, no hidden state, no side
 * effects — and every one of them is exported. That means you can
 * import this module and reuse any single piece (e.g. just `parseAmount`,
 * or just `classifyTransactions`) on its own, without having to run the
 * whole `runEngine()` pipeline.
 */

// A reservation extract has a fixed 46 transaction slots — the engine
// always reads exactly this many blocks per reservation (unused slots
// are simply empty and get ignored).
export const MAX_TRANSACTION_BLOCKS = 46;

// A "$10.00 card test" authorization is always exactly this amount.
export const CARD_TEST_AMOUNT = 10;

// A "Posted Date" string longer than this is a real date (e.g. "03/08/2025"
// is 10 characters). Placeholder values like "NA" (2 characters) or ""
// (0 characters) are always this length or shorter.
export const MIN_REAL_POSTED_DATE_LENGTH = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EngineTransactionInput {
  authDate?: string;
  postedDate?: string;
  authCode?: string;
  amount?: string | number | null;
  status?: string;
}

export interface ReservationEngineInput {
  reservationId?: string | null;
  checkInDate?: string | Date | null;
  check_in_date?: string | Date | null;
  checkoutDate?: string | Date | null;
  check_out_date?: string | Date | null;
  remainingBalance?: string | number | null;
  bookingAmount?: string | number | null;
  readyToChargeOn?: string | Date | null;
  chargeBy?: string | Date | null;
  transactions?: EngineTransactionInput[];
}

export interface ClassifiedBlock {
  transaction: EngineTransactionInput;
  parsedAmount: number | null;
  signature: string | null;
  transactionCode: 0 | 1 | 2 | 3 | 4;
}

export interface AggregatedTotals {
  activityRows: number;
  postedCharges: number;
  postedRefunds: number;
  netCollected: number;
  impliedCardLimit: number | null;
  holdsTotal: number;
  authorisedNotSettled: number;
  cardTestRows: number;
  declinedRows: number;
  blocksPresent: number;
  duplicateBlocksIgnored: number;
}

export interface MoneyFigures {
  stillOwed: number | null;
  safeToChargeNow: number | null;
  phantomBalance: number | null;
  owedButNotOnCard: number | null;
}

export interface EngineResult {
  reservationId: string;
  checkInDate: string | Date | null | undefined;
  checkoutDate: string | Date | null | undefined;
  readyToChargeOn: Date | null;
  chargeBy: Date | null;
  bookingAmount: number | null;
  remainingBalanceShown: number | null;
  activityRows: number;
  postedCharges: number;
  postedRefunds: number;
  netCollected: number;
  impliedCardLimit: number | null;
  stillOwed: number | null;
  safeToChargeNow: number | null;
  phantomBalance: number | null;
  owedButNotOnCard: number | null;
  verdict: string;
  redFlags: string[];
  timesDeclinedAtThisAmount: number;
  recommendedAction: string;
  _internal: {
    determinable: boolean;
    holdsTotal: number;
    authorisedNotSettled: number;
    cardTestRows: number;
    declinedRows: number;
    duplicateBlocksIgnored: number;
    blocksPresent: number;
  };
}

// ---------------------------------------------------------------------------
// Layer 0 — generic helpers (amount parsing, date parsing, rounding)
// ---------------------------------------------------------------------------

/**
 * Turn a raw amount into a plain number, stripping thousands commas.
 * Callers no longer send a currency prefix (no more "USD"/"CAD"/"$") —
 * amounts are just the value now, e.g. "228.20" or 228.20 — but any
 * leftover currency text is still stripped defensively so older-style
 * inputs keep working too.
 *
 * @param rawAmountText e.g. "228.20", 2, "1,396.20"
 * @returns the numeric amount, or null if it can't be parsed
 */
export function parseAmount(
  rawAmountText: string | number | null | undefined,
): number | null {
  if (rawAmountText === null || rawAmountText === undefined || rawAmountText === "")
    return null;
  if (typeof rawAmountText === "number") return rawAmountText;
  const cleanedAmountText = String(rawAmountText)
    .replace(/USD/gi, "")
    .replace(/CAD/gi, "")
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .trim();
  const numericAmount = Number(cleanedAmountText);
  return Number.isNaN(numericAmount) ? null : numericAmount;
}

/**
 * Round to 2 decimals, avoiding floating point artifacts (mirrors Excel ROUND).
 */
export function roundToTwoDecimals(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Parse "DD/MM/YYYY" or "D Month YYYY" style dates used in the extract.
 * Returns a JS Date, or null if unparseable (mirrors IFERROR(DATEVALUE(...),"")).
 *
 * @param rawDateText e.g. "18/8/2025" or "1 August 2025"
 */
export function parseFlexibleDate(
  rawDateText: string | Date | null | undefined,
): Date | null {
  if (!rawDateText) return null;
  if (rawDateText instanceof Date) return rawDateText;
  const trimmedDateText = String(rawDateText).trim();

  // D/M/YYYY or DD/MM/YYYY (day first) — this is the format checkoutDate
  // is expected in, e.g. "18/8/2025" = 18 August 2025.
  // NOTE: for an ambiguous pair like "5/8/2025", this is read as day=5,
  // month=8 (5 August) — always send checkout dates as DD/MM/YYYY.
  const dayMonthYearMatch = trimmedDateText.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/,
  );
  if (dayMonthYearMatch) {
    const [, dayText, monthText, yearText] = dayMonthYearMatch;
    const fullYear =
      yearText.length === 2 ? Number(yearText) + 2000 : Number(yearText);
    const parsedDate = new Date(fullYear, Number(monthText) - 1, Number(dayText));
    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
  }

  // "1 August 2025" style
  const parsedSpelledOutDate = new Date(trimmedDateText);
  return Number.isNaN(parsedSpelledOutDate.getTime()) ? null : parsedSpelledOutDate;
}

/** Add N days to a date, returning a new Date (does not mutate the input). */
export function addDays(date: Date, daysToAdd: number): Date {
  const resultDate = new Date(date.getTime());
  resultDate.setDate(resultDate.getDate() + daysToAdd);
  return resultDate;
}

/** Format a Date as "D Month YYYY" (same style the extract uses, e.g. "1 August 2025"). */
export function formatDateLikeExtract(date: Date): string {
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${date.getDate()} ${monthNames[date.getMonth()]} ${date.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// Layer 1-3 — per-transaction classification (SIG / CODE)
// ---------------------------------------------------------------------------

/**
 * Build a duplicate-detection signature for one transaction block.
 * Normalizes day/month order so "02/08/2025" and "08/02/2025" collide,
 * then combines with auth code + amount + first letter of status.
 * Mirrors the SIG 1..46 formulas.
 *
 * @param parsedAmount the already-parsed numeric amount for this transaction
 * @returns the signature, or null if there's no amount to key off of
 */
export function buildTransactionSignature(
  transaction: EngineTransactionInput,
  parsedAmount: number | null,
): string | null {
  if (parsedAmount === null) return null;
  const authDateText = (transaction.authDate || "").toString();
  // Excel formula reads: LEFT(date,2)=day, MID(date,4,2)=month, RIGHT(date,4)=year
  const dayPart = authDateText.slice(0, 2);
  const monthPart = authDateText.slice(3, 5);
  const yearPart = authDateText.slice(-4);
  const normalizedDayMonthKey =
    dayPart < monthPart ? dayPart + monthPart : monthPart + dayPart;
  const statusFirstLetter = (transaction.status || "")
    .toString()
    .trim()
    .charAt(0)
    .toUpperCase();
  return `${normalizedDayMonthKey}${yearPart}|${transaction.authCode || ""}|${parsedAmount}|${statusFirstLetter}`;
}

/**
 * Classify every transaction block for one reservation.
 *
 * CODE meaning:
 *   0 = ignore (empty block or exact repeat of an earlier block)
 *   1 = settled (real money moved — has a real Posted Date)
 *   2 = approved hold only (authorized but not yet settled)
 *   3 = declined (or anything else that isn't settled/hold/card-test)
 *   4 = $10 card-test authorization
 *
 * @param transactions up to 46 raw transaction blocks
 */
export function classifyTransactions(
  transactions: EngineTransactionInput[],
): ClassifiedBlock[] {
  const classifiedBlocks: ClassifiedBlock[] = [];
  const signaturesSeenSoFar: string[] = [];

  for (let blockIndex = 0; blockIndex < MAX_TRANSACTION_BLOCKS; blockIndex++) {
    const transaction = transactions[blockIndex] || {};
    const parsedAmount = parseAmount(transaction.amount);
    const signature = buildTransactionSignature(transaction, parsedAmount);

    let transactionCode: 0 | 1 | 2 | 3 | 4 = 0;
    const isDuplicateOfEarlierBlock =
      signature !== null && signaturesSeenSoFar.includes(signature);

    if (parsedAmount === null || isDuplicateOfEarlierBlock) {
      transactionCode = 0; // empty block or exact repeat of an earlier block
    } else {
      const postedDateText = (transaction.postedDate || "").toString();
      const statusText = (transaction.status || "").toString();

      if (postedDateText.length > MIN_REAL_POSTED_DATE_LENGTH) {
        transactionCode = 1; // real posted date -> settled, real money
      } else if (parsedAmount === CARD_TEST_AMOUNT) {
        transactionCode = 4; // $10.00 card-test authorization
      } else if (statusText.trim().toUpperCase().startsWith("A")) {
        transactionCode = 2; // Approved -> hold only
      } else {
        transactionCode = 3; // Declined / anything else
      }
    }

    if (signature !== null) signaturesSeenSoFar.push(signature);
    classifiedBlocks.push({ transaction, parsedAmount, signature, transactionCode });
  }

  return classifiedBlocks;
}

// ---------------------------------------------------------------------------
// Layer 4 — per-reservation aggregation
// ---------------------------------------------------------------------------

/**
 * Roll up all classified transaction blocks for one reservation into
 * summary totals (posted charges/refunds, holds, activity counts, etc.).
 */
export function aggregateTransactionTotals(
  classifiedBlocks: ClassifiedBlock[],
  remainingBalance: number | null,
): AggregatedTotals {
  const settledBlocks = classifiedBlocks.filter((block) => block.transactionCode === 1);
  // "Activity Rows" in the sheet = COUNTIF(CODE range, ">0") — i.e. ANY
  // classified, non-duplicate transaction (settled OR hold OR declined OR
  // card-test), not just settled ones. Verified against reservation
  // 2215243957 where Activity Rows = 7 while only 3 were settled.
  const activityRows = classifiedBlocks.filter((block) => block.transactionCode > 0).length;
  const postedCharges = roundToTwoDecimals(
    settledBlocks
      .filter((block) => (block.parsedAmount as number) > 0)
      .reduce((sum, block) => sum + (block.parsedAmount as number), 0),
  );
  const postedRefunds = roundToTwoDecimals(
    -settledBlocks
      .filter((block) => (block.parsedAmount as number) < 0)
      .reduce((sum, block) => sum + (block.parsedAmount as number), 0),
  );
  const netCollected = roundToTwoDecimals(postedCharges - postedRefunds);
  const impliedCardLimit =
    remainingBalance === null ? null : roundToTwoDecimals(remainingBalance + netCollected);

  const holdsTotal = roundToTwoDecimals(
    classifiedBlocks
      .filter((block) => block.transactionCode === 2)
      .reduce((sum, block) => sum + (block.parsedAmount as number), 0),
  );
  const authorisedNotSettled = Math.max(
    0,
    roundToTwoDecimals(holdsTotal - postedCharges - postedRefunds),
  );
  const cardTestRows = classifiedBlocks.filter((block) => block.transactionCode === 4).length;
  const declinedRows = classifiedBlocks.filter((block) => block.transactionCode === 3).length;

  const blocksPresent = classifiedBlocks.filter((block) => block.parsedAmount !== null).length;
  // duplicates ignored = amount-bearing blocks minus the ones that got a
  // real code (1/2/3/4); anything left over was marked CODE 0 as a dup.
  const duplicateBlocksIgnored = blocksPresent - activityRows;

  return {
    activityRows,
    postedCharges,
    postedRefunds,
    netCollected,
    impliedCardLimit,
    holdsTotal,
    authorisedNotSettled,
    cardTestRows,
    declinedRows,
    blocksPresent,
    duplicateBlocksIgnored,
  };
}

// ---------------------------------------------------------------------------
// Layer 5 — the money numbers
// ---------------------------------------------------------------------------

/**
 * Compute the four headline money figures for a reservation.
 */
export function computeMoneyFigures({
  bookingAmount,
  remainingBalance,
  netCollected,
}: {
  bookingAmount: number;
  remainingBalance: number | null;
  netCollected: number;
}): MoneyFigures {
  let stillOwed: number;
  if (bookingAmount <= 0.02) {
    stillOwed = Math.min(0, roundToTwoDecimals(bookingAmount - netCollected));
  } else {
    stillOwed = roundToTwoDecimals(bookingAmount - netCollected);
  }

  const safeToChargeNow =
    remainingBalance === null ? null : Math.max(0, Math.min(stillOwed, remainingBalance));
  const phantomBalance =
    remainingBalance === null || safeToChargeNow === null
      ? null
      : roundToTwoDecimals(remainingBalance - safeToChargeNow);
  const owedButNotOnCard =
    remainingBalance === null ? null : Math.max(0, roundToTwoDecimals(stillOwed - remainingBalance));

  return { stillOwed, safeToChargeNow, phantomBalance, owedButNotOnCard };
}

// ---------------------------------------------------------------------------
// Layer 6 — VERDICT decision tree
// ---------------------------------------------------------------------------

/**
 * Decide the R0-R7 verdict for a reservation.
 */
export function computeVerdict({
  reservationId,
  remainingBalance,
  bookingAmount,
  activityRows,
  netCollected,
  stillOwed,
}: {
  reservationId: string | null;
  remainingBalance: number | null;
  bookingAmount: number | null;
  activityRows: number;
  netCollected: number;
  stillOwed: number | null;
}): string {
  if (!reservationId || reservationId === "No ID") return "R7 REVIEW - no reservation ID";
  if (remainingBalance === null) return "R7 REVIEW - no balance shown";
  if (bookingAmount === null) return "R7 REVIEW - no booking amount";

  if (bookingAmount <= 0.02) {
    if (netCollected > 0.02) return "R6 OVER-COLLECTED - refund due";
    if (activityRows === 0) return "R7 REVIEW - zero booking, no activity";
    return "R5 CANCELLED/REVERSED - collect nothing";
  }

  if (activityRows === 0) return "R0 UNTOUCHED - card not used yet";
  if ((stillOwed as number) < -0.02) return "R6 OVER-COLLECTED - refund due";
  if ((stillOwed as number) <= 0.02) {
    return remainingBalance > 1
      ? "R4 SETTLED - balance is PHANTOM, do not charge"
      : "R4 SETTLED - nothing left";
  }
  if (remainingBalance <= 0.02) return "R3 OWED but CARD EMPTY - escalate to OTA";
  if (remainingBalance + 0.02 < (stillOwed as number)) return "R2 PARTIAL - card covers only part";
  if (remainingBalance > (stillOwed as number) + 1) return "R1 COLLECT EXACT - card over-funded";
  return "R1 COLLECT - card matches what is owed";
}

// ---------------------------------------------------------------------------
// Layer 7 — RED FLAGS
// ---------------------------------------------------------------------------

/**
 * Identify red flags that need human attention for this reservation.
 */
export function computeRedFlags({
  postedRefunds,
  bookingAmount,
  impliedCardLimit,
  chargeByDate,
  readyDate,
  authorisedNotSettled,
  duplicateBlocksIgnored,
  cardTestRows,
  declinedRows,
  transactions,
  today,
}: {
  postedRefunds: number;
  bookingAmount: number | null;
  impliedCardLimit: number | null;
  chargeByDate: Date | null;
  readyDate: Date | null;
  authorisedNotSettled: number;
  duplicateBlocksIgnored: number;
  cardTestRows: number;
  declinedRows: number;
  transactions: EngineTransactionInput[];
  today: Date;
}): string[] {
  const redFlags: string[] = [];

  if (postedRefunds > 0.02) redFlags.push("REFUND_ON_CARD");
  if (
    bookingAmount !== null &&
    impliedCardLimit !== null &&
    Math.abs(impliedCardLimit - bookingAmount) > 0.05
  ) {
    redFlags.push("LIMIT<>BOOKING");
  }
  if (chargeByDate && chargeByDate < today) redFlags.push("PAST_CHARGE_BY");
  if (readyDate && readyDate > today) redFlags.push("NOT_OPEN_YET");
  if (authorisedNotSettled > 0.02) redFlags.push("OPEN_HOLD");
  if (duplicateBlocksIgnored > 0) redFlags.push("DUPLICATE_ROWS_IGNORED");
  if (cardTestRows > 0) redFlags.push("CARD_TEST_ROWS");
  if (declinedRows >= 3) redFlags.push("REPEATED_DECLINES");

  const combinedStatusText = transactions
    .map((transaction) => (transaction.status || "").toLowerCase())
    .join(" | ");
  if (combinedStatusText.includes("merchant category")) redFlags.push("MCC_DECLINE");
  if (combinedStatusText.includes("not yet active")) redFlags.push("CHARGED_TOO_EARLY");

  return redFlags;
}

// ---------------------------------------------------------------------------
// Layer 8 — RECOMMENDED ACTION
// ---------------------------------------------------------------------------

/**
 * Turn the money figures into a plain-English recommended next step.
 */
export function computeRecommendedAction({
  determinable,
  safeToChargeNow,
  timesDeclinedAtThisAmount,
  owedButNotOnCard,
  phantomBalance,
}: {
  determinable: boolean;
  safeToChargeNow: number | null;
  timesDeclinedAtThisAmount: number;
  owedButNotOnCard: number | null;
  phantomBalance: number | null;
}): string {
  if (!determinable) return "Review manually";

  if ((safeToChargeNow as number) > 0.02) {
    if (timesDeclinedAtThisAmount >= 3) {
      return `DO NOT RETRY - card refused this amount ${timesDeclinedAtThisAmount} times; escalate to OTA`;
    }
    if (timesDeclinedAtThisAmount > 0) {
      return `Charge $${(safeToChargeNow as number).toFixed(2)} once; if it declines again, escalate`;
    }
    return `Charge exactly $${(safeToChargeNow as number).toFixed(2)}`;
  }

  if ((owedButNotOnCard as number) > 0.02) {
    return `Nothing on the card - claim $${(owedButNotOnCard as number).toFixed(2)} from the OTA`;
  }
  if (phantomBalance !== null && phantomBalance > 1) {
    return `DO NOT TOUCH - $${phantomBalance.toFixed(2)} on this card is not ours`;
  }
  return "No action";
}

// ---------------------------------------------------------------------------
// Helper — derive Ready to Charge On / Charge By from a checkout date
// ---------------------------------------------------------------------------

/**
 * Business rule (not part of the original sheet's formulas — this is a
 * convenience helper you asked for):
 *   Ready to Charge On = checkout date + 7 days
 *   Charge By           = checkout date + 365 days
 *
 * Accepts a checkout date as a string ("28/7/2025", "28 July 2025") or Date,
 * and returns both a Date object and an extract-style string for each,
 * ready to feed straight into runEngine()'s readyToChargeOn / chargeBy fields.
 */
export function computeChargeWindow(checkoutDate: string | Date): {
  readyToChargeOn: Date;
  chargeBy: Date;
  readyToChargeOnText: string;
  chargeByText: string;
} {
  const parsedCheckoutDate = parseFlexibleDate(checkoutDate);
  if (!parsedCheckoutDate) {
    throw new Error(`computeChargeWindow: could not parse checkout date "${checkoutDate}"`);
  }

  const readyToChargeOnDate = addDays(parsedCheckoutDate, 7);
  const chargeByDate = addDays(parsedCheckoutDate, 365);

  return {
    readyToChargeOn: readyToChargeOnDate,
    chargeBy: chargeByDate,
    readyToChargeOnText: formatDateLikeExtract(readyToChargeOnDate),
    chargeByText: formatDateLikeExtract(chargeByDate),
  };
}

// ---------------------------------------------------------------------------
// MAIN ENTRY POINT
// ---------------------------------------------------------------------------

/**
 * Run the full engine on one reservation and return the verdict object
 * (equivalent to one row of "3 Reservation Verdicts").
 */
export function runEngine(
  reservation: ReservationEngineInput,
  { today = new Date() }: { today?: Date } = {},
): EngineResult | null {
  const {
    reservationId,
    // Accept both camelCase (checkInDate/checkoutDate) and snake_case
    // (check_in_date/check_out_date) field names, and either a Date
    // object, an ISO string ("2026-07-28T00:00:00.000Z"), or the classic
    // extract-style string ("28/7/2025", "28 July 2025") for the value.
    // Whichever naming convention the caller uses, both are read here so
    // this stays a drop-in reusable component for different data sources.
    checkInDate: checkInDateCamelCase = null,
    check_in_date: checkInDateSnakeCase = null,
    checkoutDate: checkoutDateCamelCase = null, // preferred way to supply the charge window
    check_out_date: checkoutDateSnakeCase = null,
    remainingBalance: remainingBalanceRawText,
    bookingAmount: bookingAmountRawText,
    readyToChargeOn: readyToChargeOnManualOverride = null, // legacy/manual override
    chargeBy: chargeByManualOverride = null, // legacy/manual override
    transactions = [],
  } = reservation;

  const checkInDate = checkInDateCamelCase !== null ? checkInDateCamelCase : checkInDateSnakeCase;
  const checkoutDate = checkoutDateCamelCase !== null ? checkoutDateCamelCase : checkoutDateSnakeCase;

  // Derive Ready to Charge On / Charge By from Checkout Date whenever a
  // checkout date is supplied. Manual readyToChargeOn/chargeBy values are
  // only used as a fallback when no checkoutDate is given (e.g. importing
  // old extracts that already have these two fields written on them).
  let readyToChargeOn: string | Date | null = readyToChargeOnManualOverride;
  let chargeBy: string | Date | null = chargeByManualOverride;
  if (checkoutDate) {
    const chargeWindow = computeChargeWindow(checkoutDate);
    readyToChargeOn = chargeWindow.readyToChargeOnText;
    chargeBy = chargeWindow.chargeByText;
  }

  const remainingBalance = parseAmount(remainingBalanceRawText);
  const bookingAmount = parseAmount(bookingAmountRawText);
  const readyDate = parseFlexibleDate(readyToChargeOn);
  const chargeByDate = parseFlexibleDate(chargeBy);

  const isReservationIdPresent = !!reservationId && reservationId !== "No ID";
  const hasAnyData = isReservationIdPresent || remainingBalanceRawText !== undefined;

  if (!hasAnyData) return null; // mirrors U column = 0 -> blank row

  const classifiedBlocks = classifyTransactions(transactions);
  const aggregatedTotals = aggregateTransactionTotals(classifiedBlocks, remainingBalance);

  // NOTE: mirrors AH2 in the sheet exactly — determinable requires ID,
  // Booking Amount, Remaining Balance to be present AND at least one
  // settled ("Activity Row") transaction to exist. With zero activity
  // rows (card untouched, or nothing ever posted), the sheet always
  // falls back to "Review manually" regardless of the money numbers.
  const determinable =
    isReservationIdPresent &&
    bookingAmount !== null &&
    remainingBalance !== null &&
    aggregatedTotals.activityRows > 0;

  let moneyFigures: MoneyFigures = {
    stillOwed: null,
    safeToChargeNow: null,
    phantomBalance: null,
    owedButNotOnCard: null,
  };
  if (bookingAmount !== null) {
    moneyFigures = computeMoneyFigures({
      bookingAmount,
      remainingBalance,
      netCollected: aggregatedTotals.netCollected,
    });
    // SAFE TO CHARGE / PHANTOM / OWED NOT ON CARD stay blank (null) unless
    // Determinable — mirrors IF($AH2=0,"",...) in columns M/N/O of the sheet.
    // STILL OWED itself is NOT gated this way; it always computes.
    if (!determinable) {
      moneyFigures.safeToChargeNow = null;
      moneyFigures.phantomBalance = null;
      moneyFigures.owedButNotOnCard = null;
    }
  }

  const verdict = computeVerdict({
    reservationId: isReservationIdPresent ? (reservationId as string) : null,
    remainingBalance,
    bookingAmount,
    activityRows: aggregatedTotals.activityRows,
    netCollected: aggregatedTotals.netCollected,
    stillOwed: moneyFigures.stillOwed,
  });

  const redFlags = computeRedFlags({
    postedRefunds: aggregatedTotals.postedRefunds,
    bookingAmount,
    impliedCardLimit: aggregatedTotals.impliedCardLimit,
    chargeByDate,
    readyDate,
    authorisedNotSettled: aggregatedTotals.authorisedNotSettled,
    duplicateBlocksIgnored: aggregatedTotals.duplicateBlocksIgnored,
    cardTestRows: aggregatedTotals.cardTestRows,
    declinedRows: aggregatedTotals.declinedRows,
    transactions,
    today,
  });

  const timesDeclinedAtThisAmount =
    determinable && (moneyFigures.safeToChargeNow as number) > 0.02
      ? classifiedBlocks.filter(
          (block) =>
            block.transactionCode === 3 &&
            roundToTwoDecimals(block.parsedAmount as number) ===
              roundToTwoDecimals(moneyFigures.safeToChargeNow as number),
        ).length
      : 0;

  const recommendedAction = determinable
    ? computeRecommendedAction({
        determinable,
        safeToChargeNow: moneyFigures.safeToChargeNow,
        timesDeclinedAtThisAmount,
        owedButNotOnCard: moneyFigures.owedButNotOnCard,
        phantomBalance: moneyFigures.phantomBalance,
      })
    : "Review manually";

  return {
    // columns A-S equivalent
    reservationId: isReservationIdPresent ? (reservationId as string) : "(no reservation ID)",
    checkInDate,
    checkoutDate,
    readyToChargeOn: readyDate,
    chargeBy: chargeByDate,
    bookingAmount,
    remainingBalanceShown: remainingBalance,
    activityRows: aggregatedTotals.activityRows,
    postedCharges: aggregatedTotals.postedCharges,
    postedRefunds: aggregatedTotals.postedRefunds,
    netCollected: aggregatedTotals.netCollected,
    impliedCardLimit: aggregatedTotals.impliedCardLimit,
    stillOwed: moneyFigures.stillOwed,
    safeToChargeNow: moneyFigures.safeToChargeNow,
    phantomBalance: moneyFigures.phantomBalance,
    owedButNotOnCard: moneyFigures.owedButNotOnCard,
    verdict,
    redFlags,
    timesDeclinedAtThisAmount,
    recommendedAction,

    // extra engine internals (columns U-AI equivalent), handy for debugging/QA
    _internal: {
      determinable,
      holdsTotal: aggregatedTotals.holdsTotal,
      authorisedNotSettled: aggregatedTotals.authorisedNotSettled,
      cardTestRows: aggregatedTotals.cardTestRows,
      declinedRows: aggregatedTotals.declinedRows,
      duplicateBlocksIgnored: aggregatedTotals.duplicateBlocksIgnored,
      blocksPresent: aggregatedTotals.blocksPresent,
    },
  };
}
