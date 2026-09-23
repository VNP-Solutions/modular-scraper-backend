import {
  Authorization,
  MoneyAmount,
  Settlement,
} from "../models/card-activity.model.js";
import type {
  BalanceEngineData,
  CreateCardActivityData,
} from "../services/job.service.js";
import {
  EngineResult,
  EngineTransactionInput,
  runEngine,
} from "./vcc-balance-engine.js";

/**
 * Parse a date-like value (ISO, "YYYY-MM-DD HH:mm:ss.SSS", etc.) to a Date,
 * returning undefined when input is empty/invalid.
 */
function parseCardActivityDate(value: any): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return isNaN(d.getTime()) ? undefined : d;
}

function parseMoneyAmount(raw: any): MoneyAmount | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const amount =
    typeof raw.amount === "number"
      ? raw.amount
      : raw.amount !== undefined && raw.amount !== null
      ? parseFloat(raw.amount)
      : undefined;
  const currency =
    typeof raw.currency === "string" ? raw.currency : undefined;
  if ((amount === undefined || isNaN(amount)) && !currency) return undefined;
  return {
    amount: amount !== undefined && !isNaN(amount) ? amount : undefined,
    currency,
  };
}

/**
 * Normalize the `cardActivity` block from an EVC response into the shape
 * expected by the CardActivity model.
 */
export function buildCardActivityFromEvc(
  evcCardData: any | null,
): CreateCardActivityData | null {
  const ca = evcCardData?.cardActivity;
  if (!ca) return null;

  console.log(`🔍 Card Activity:`, ca);
  const totalSettlementAmount = parseMoneyAmount(ca.totalSettlementAmount);

  const authorizations: Authorization[] = Array.isArray(ca.authorizations)
    ? ca.authorizations.map((a: any) => ({
        dateTime: parseCardActivityDate(a?.dateTime),
        status: a?.status ?? undefined,
        authCode: a?.authCode ?? null,
        declineCode: a?.declineCode ?? null,
        responseDescription:
          a?.responseDescription ?? a?.responseDecription ?? null,
        amount: parseMoneyAmount(a?.amount),
      }))
    : [];

  // `settlements` carries the actual posted/settled money movement for a
  // prior authorization (matched by `authCode`) — this is where the real
  // "Posted Date" lives. `authorizations` alone only ever represent a hold.
  const settlements: Settlement[] = Array.isArray(ca.settlements)
    ? ca.settlements.map((s: any) => ({
        transactionDate: parseCardActivityDate(s?.transactionDate),
        postDate: parseCardActivityDate(s?.postDate),
        authCode: s?.authCode ?? null,
        referenceNumber: s?.referenceNumber ?? null,
        amount: parseMoneyAmount(s?.amount),
      }))
    : [];

  const hasAny =
    !!totalSettlementAmount || authorizations.length > 0 || settlements.length > 0;
  if (!hasAny) return null;

  return {
    totalSettlementAmount,
    authorizations,
    settlements,
  };
}

/** Format a Date as "DD/MM/YYYY" (UTC calendar day) — the format the VCC balance
 * engine expects for transaction dates. Returns "NA" when there's no date, so the
 * engine treats it as a placeholder, not a real one. */
function formatDateForEngine(date: Date | undefined | null): string {
  if (!date || isNaN(date.getTime())) return "NA";
  const [year, month, day] = date.toISOString().slice(0, 10).split("-");
  return `${day}/${month}/${year}`;
}

/**
 * Turn a CardActivity's `authorizations` (holds/declines) and `settlements`
 * (posted money) into the flat `transactions[]` shape the VCC balance engine
 * expects. Each authorization and each settlement is its own transaction
 * block — an authorization and its settlement are two different events.
 *
 * Settlements use status "NA" (as Expedia's extract does), so their
 * duplicate signature can never collide with an authorization's ("A…"/"D…");
 * only a genuinely repeated authorization or settlement is deduped.
 */
export function buildEngineTransactions(
  cardActivity: CreateCardActivityData | null,
): EngineTransactionInput[] {
  if (!cardActivity) return [];

  const authorizations = cardActivity.authorizations || [];
  const settlements = cardActivity.settlements || [];

  const transactions: EngineTransactionInput[] = [];

  for (const auth of authorizations) {
    // Red flags like MCC_DECLINE / CHARGED_TOO_EARLY match on the decline text.
    const statusText = [auth.status, auth.responseDescription]
      .filter(Boolean)
      .join(" ");
    transactions.push({
      authDate: formatDateForEngine(auth.dateTime),
      postedDate: "NA",
      authCode: auth.authCode || "NA",
      amount: auth.amount?.amount ?? null,
      status: statusText || "NA",
    });
  }

  for (const settlement of settlements) {
    transactions.push({
      authDate: formatDateForEngine(settlement.transactionDate),
      postedDate: formatDateForEngine(settlement.postDate),
      authCode: settlement.authCode || "NA",
      amount: settlement.amount?.amount ?? null,
      status: "NA",
    });
  }

  return transactions;
}

export interface BalanceEngineItemInput {
  reservationId: string;
  checkInDate: Date;
  checkOutDate: Date;
  bookingAmount: number | null;
  remainingBalance: number | null;
  cardActivity: CreateCardActivityData | null;
}

function toJobItemFields(result: EngineResult): BalanceEngineData {
  return {
    activityRows: result.activityRows,
    postedCharges: result.postedCharges,
    postedRefunds: result.postedRefunds,
    netCollected: result.netCollected,
    impliedCardLimit: result.impliedCardLimit,
    stillOwed: result.stillOwed,
    safeToChargeNow: result.safeToChargeNow,
    phantomBalance: result.phantomBalance,
    owedButNotOnCard: result.owedButNotOnCard,
    verdict: result.verdict,
    redFlags: result.redFlags,
    timesDeclinedAtThisAmount: result.timesDeclinedAtThisAmount,
    recommendedAction: result.recommendedAction,
  };
}

/**
 * Run the VCC Remaining Balance Engine for one item and return the transactions
 * it was fed, the raw engine result, and the fields to store on JobItem.
 * Throws if the engine throws (e.g. an unparseable checkout date).
 */
export function runBalanceEngineForItem(input: BalanceEngineItemInput): {
  transactions: EngineTransactionInput[];
  result: EngineResult | null;
  fields: BalanceEngineData;
} {
  const transactions = buildEngineTransactions(input.cardActivity);

  const result = runEngine({
    reservationId: input.reservationId,
    check_in_date: input.checkInDate,
    check_out_date: input.checkOutDate,
    remainingBalance: input.remainingBalance,
    bookingAmount: input.bookingAmount,
    transactions,
  });

  return { transactions, result, fields: result ? toJobItemFields(result) : {} };
}

/**
 * Same as runBalanceEngineForItem, but never throws: returns an empty object
 * on failure so the scraper can spread it into jobItemData without extra checks.
 */
export function computeBalanceEngineFieldsForItem(
  input: BalanceEngineItemInput,
): BalanceEngineData {
  try {
    return runBalanceEngineForItem(input).fields;
  } catch (engineError: any) {
    console.error(
      `❌ VCC balance engine failed for reservation ${input.reservationId}:`,
      engineError?.message || engineError,
    );
    return {};
  }
}
