import XLSX from "xlsx";
import type { WorkSheet } from "xlsx";
import type { Authorization } from "../models/card-activity.model.js";
import type { IJobItem } from "../models/job-item.model.js";
import { PostingType, type IJob } from "../models/job.model.js";
import type { IProperty } from "../models/property.model.js";

/**
 * Expedia master export — columns §1.1 `automated-export.md` (static 1–26 + §2 cols 27–29
 * and dynamic `Card Activity Approved Amount K` when any row has approved auths).
 */

const EXPEDIA_STATIC_HEADERS_1_26 = [
  "OTA",
  "OTA Posting Type",
  "OTA ID",
  "Batch",
  "Review Collection Date",
  "Portfolio",
  "Property Name",
  "Reservation ID",
  "Hotel Confirmation Code",
  "Guest name",
  "Check In",
  "Check Out",
  "Charge Before",
  "Currency",
  "Booking Amount",
  "Amount to Charge",
  "Card Status",
  "Card Number",
  "Expiry date",
  "CVV",
  "Due to Property",
  "Due to VNP/Invoice",
  "Processor (DBMS Based on OTA)",
  "QP Username (From DBMS)",
  "Case Contact (From DBMS)",
  "Reporting Contact (From DBMS)",
] as const;

const EXPEDIA_TAIL_FIXED = [
  "Card Activity",
  "Calculated Amount to Charge",
  "Amount Match",
] as const;

function jobToPlain(job: IJob): Record<string, unknown> {
  if (typeof job === "object" && job !== null && "toObject" in job) {
    const doc = job as { toObject: () => Record<string, unknown> };
    if (typeof doc.toObject === "function") return doc.toObject();
  }
  return JSON.parse(JSON.stringify(job)) as Record<string, unknown>;
}

function itemToPlain(item: IJobItem | Record<string, unknown>): Record<string, unknown> {
  if (typeof item === "object" && item !== null && "toObject" in item) {
    const doc = item as { toObject: () => Record<string, unknown> };
    if (typeof doc.toObject === "function") return doc.toObject();
  }
  return JSON.parse(JSON.stringify(item)) as Record<string, unknown>;
}

function formatPostingType(jobPlain: Record<string, unknown>): string {
  const pt = jobPlain.posting_type;
  if (pt === PostingType.OTA_PLUS) return "OTA Post";
  if (pt === PostingType.OTA) return "OTA";
  return "";
}

function resolveBatchName(jobPlain: Record<string, unknown>): string {
  const batch = jobPlain.batch;
  if (batch && typeof batch === "object" && batch !== null) {
    const name = (batch as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  const bn = jobPlain.batch_name;
  if (typeof bn === "string" && bn.trim()) return bn.trim();
  return "";
}

/** §2 col 5: `job.end_date` as MMM dd, yyyy */
function formatReviewCollectionDate(raw: unknown): string {
  if (raw == null || raw === "") return "";
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return raw.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  const s = String(raw).trim();
  if (!s) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo, d, 12, 0, 0));
    return dt.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  return s;
}

/** Expedia §2 cols 11–12: check-in / check-out as MMM dd, yyyy */
function formatItemDateMmDdYyyy(raw: unknown): string {
  return formatReviewCollectionDate(raw);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function approvedOnly(auths: Authorization[]): Authorization[] {
  return (auths || []).filter(
    (a) => String(a.status ?? "").trim().toLowerCase() === "approved",
  );
}

function dateTimeToIso(dt: unknown): string {
  if (dt instanceof Date && !Number.isNaN(dt.getTime())) return dt.toISOString();
  if (dt == null || dt === "") return "";
  const d = new Date(dt as string | number);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/** §2 col 27: only Approved auths, fixed export shape */
function cardActivityJsonForExport(auths: Authorization[]): string {
  const approved = approvedOnly(auths);
  const payload = approved.map((a) => ({
    dateTime: dateTimeToIso(a.dateTime),
    status: "Approved" as const,
    authCode: a.authCode ?? null,
    declineCode: a.declineCode ?? null,
    responseDescription: a.responseDescription ?? null,
    amount:
      a.amount &&
      (a.amount.amount !== undefined ||
        (a.amount.currency != null && String(a.amount.currency).trim() !== ""))
        ? {
            amount:
              a.amount!.amount !== undefined && a.amount!.amount !== null
                ? Number(a.amount!.amount)
                : null,
            currency: a.amount!.currency ?? null,
          }
        : null,
  }));
  return JSON.stringify(payload);
}

function sumApprovedAmounts(auths: Authorization[]): number {
  return approvedOnly(auths).reduce((s, a) => {
    const v = a.amount?.amount;
    if (v === undefined || v === null || Number.isNaN(Number(v))) return s;
    return s + Number(v);
  }, 0);
}

function formatApprovedAmountK(auth: Authorization | undefined): string {
  if (!auth?.amount) return "";
  const c = auth.amount.currency?.trim();
  const a = auth.amount.amount;
  if (a === undefined || a === null || Number.isNaN(Number(a))) {
    return c ? `${c}` : "";
  }
  const amt = round2(Number(a));
  return c ? `${c} ${amt}` : String(amt);
}

function cardNumberGroupedForExport(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  const parts: string[] = [];
  for (let i = 0; i < digits.length; i += 4) {
    parts.push(digits.slice(i, i + 4));
  }
  return parts.join(" ");
}

function buildHeaders(maxApprovedAcrossRows: number): string[] {
  const tail: string[] = [...EXPEDIA_TAIL_FIXED];
  for (let k = 1; k <= maxApprovedAcrossRows; k++) {
    tail.push(`Card Activity Approved Amount ${k}`);
  }
  return [...EXPEDIA_STATIC_HEADERS_1_26, ...tail];
}

function rowToObject(
  plain: Record<string, unknown>,
  jobPlain: Record<string, unknown>,
  otaId: string,
  authorizations: Authorization[],
  headerList: string[],
): Record<string, string | number> {
  const card = (plain.card_info as Record<string, unknown>) || {};
  const pay = (plain.payment_info as Record<string, unknown>) || {};

  const currencyRaw = pay.amount_to_charge_or_refund_currency;
  const currency =
    currencyRaw != null && String(currencyRaw).trim() !== ""
      ? String(currencyRaw).trim()
      : "USD";

  const amtRaw = pay.amount_to_charge_or_refund;
  let amountToCharge: string | number = "";
  if (amtRaw != null && amtRaw !== "") {
    const n = typeof amtRaw === "number" ? amtRaw : Number(amtRaw);
    amountToCharge = Number.isFinite(n) ? n : "";
  }

  const bookingRaw = plain.booking_amount;
  let bookingAmountCell: string | number = "";
  if (bookingRaw != null && bookingRaw !== "") {
    const n = typeof bookingRaw === "number" ? bookingRaw : Number(bookingRaw);
    bookingAmountCell = Number.isFinite(n) ? round2(n) : "";
  }

  const approved = approvedOnly(authorizations);
  const sumAuth = sumApprovedAmounts(authorizations);

  let calculatedCell: string | number = "";
  if (bookingAmountCell !== "") {
    calculatedCell = round2(Number(bookingAmountCell) - sumAuth);
  }

  let amountMatchCell = "No";
  if (
    calculatedCell !== "" &&
    amountToCharge !== "" &&
    typeof calculatedCell === "number" &&
    typeof amountToCharge === "number"
  ) {
    amountMatchCell =
      round2(calculatedCell) === round2(amountToCharge) ? "Yes" : "No";
  } else if (calculatedCell === "" && amountToCharge === "") {
    amountMatchCell = "No";
  }

  const cardNumRaw = String(card.card_number ?? "").trim();
  const cardNumberCell = cardNumRaw
    ? cardNumberGroupedForExport(cardNumRaw)
    : "";

  const base = {
    OTA: "Expedia",
    "OTA Posting Type": formatPostingType(jobPlain),
    "OTA ID": otaId,
    Batch: resolveBatchName(jobPlain),
    "Review Collection Date": formatReviewCollectionDate(jobPlain.end_date),
    Portfolio: String(jobPlain.portfolio_name ?? ""),
    "Property Name": String(jobPlain.property_name ?? ""),
    "Reservation ID": String(plain.reservation_id ?? ""),
    "Hotel Confirmation Code": String(plain.confirmation_number ?? ""),
    "Guest name": String(plain.guest_name ?? ""),
    "Check In": formatItemDateMmDdYyyy(plain.check_in_date),
    "Check Out": formatItemDateMmDdYyyy(plain.check_out_date),
    "Charge Before": "N/A",
    Currency: currency,
    "Booking Amount": bookingAmountCell,
    "Amount to Charge": amountToCharge,
    "Card Status": String(card.reason_for_charge ?? ""),
    "Card Number": cardNumberCell,
    "Expiry date": String(card.expiry_date ?? "").trim(),
    CVV: String(card.cvv ?? "").trim(),
    "Due to Property": "",
    "Due to VNP/Invoice": "",
    "Processor (DBMS Based on OTA)": "",
    "QP Username (From DBMS)": "",
    "Case Contact (From DBMS)": "",
    "Reporting Contact (From DBMS)": "",
    "Card Activity": cardActivityJsonForExport(authorizations),
    "Calculated Amount to Charge": calculatedCell,
    "Amount Match": amountMatchCell,
  } as Record<string, string | number>;

  const maxK = headerList.filter((h) =>
    h.startsWith("Card Activity Approved Amount "),
  ).length;
  for (let k = 1; k <= maxK; k++) {
    const key = `Card Activity Approved Amount ${k}`;
    base[key] = formatApprovedAmountK(approved[k - 1]);
  }

  for (const h of headerList) {
    if (!(h in base)) base[h] = "";
  }
  return base;
}

const EXCEL_TEXT_FORMAT = "@";

function formatColumnAsText(sheet: WorkSheet, colIndex: number): void {
  const ref = sheet["!ref"];
  if (!ref) return;
  const range = XLSX.utils.decode_range(ref);
  for (let r = range.s.r; r <= range.e.r; r++) {
    const addr = XLSX.utils.encode_cell({ r, c: colIndex });
    const cell = sheet[addr];
    if (!cell) continue;
    const text = String(cell.v ?? "");
    sheet[addr] = { t: "s", v: text, z: EXCEL_TEXT_FORMAT };
  }
}

export type JobItemWithAuthorizations = {
  item: IJobItem;
  authorizations: Authorization[];
};

/**
 * Expedia job_items → XLSX aligned with `automated-export.md` §1.1 / §2 (Expedia).
 * Pass rows from `jobService.getJobItemsWithCardActivitiesForExport(jobId)`.
 */
export function jobItemsToChargeReportXlsxBuffer(
  itemsWithAuth: JobItemWithAuthorizations[],
  job: IJob,
  property: IProperty | null,
): Buffer {
  const jobPlain = jobToPlain(job);
  const otaId =
    property?.expedia_id != null ? String(property.expedia_id) : "";

  let maxApproved = 0;
  for (const { authorizations } of itemsWithAuth) {
    const n = approvedOnly(authorizations).length;
    if (n > maxApproved) maxApproved = n;
  }

  const headerList = buildHeaders(maxApproved);
  const rows = itemsWithAuth.map(({ item, authorizations }) =>
    rowToObject(
      itemToPlain(item),
      jobPlain,
      otaId,
      authorizations,
      headerList,
    ),
  );

  const sheet = XLSX.utils.json_to_sheet(rows, {
    header: headerList,
  });

  for (const h of ["Card Number", "Expiry date", "CVV"] as const) {
    const col = headerList.indexOf(h);
    if (col >= 0) formatColumnAsText(sheet, col);
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Job items");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
