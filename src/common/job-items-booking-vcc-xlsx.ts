import XLSX from "xlsx";
import type { WorkSheet } from "xlsx";
import { PostingType, type IJob } from "../models/job.model.js";
import type { IProperty } from "../models/property.model.js";

/**
 * Booking master CSV columns (§1.2 automated-export.md). Same order as
 * `buildMasterRows` Booking branch — 26 static columns, no Card Activity block.
 */
const BOOKING_MASTER_EXPORT_HEADERS = [
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

type BookingMasterHeader = (typeof BOOKING_MASTER_EXPORT_HEADERS)[number];

function jobToPlain(job: IJob): Record<string, unknown> {
  if (typeof job === "object" && job !== null && "toObject" in job) {
    const doc = job as { toObject: () => Record<string, unknown> };
    if (typeof doc.toObject === "function") {
      return doc.toObject();
    }
  }
  return JSON.parse(JSON.stringify(job)) as Record<string, unknown>;
}

function itemToPlain(item: unknown): Record<string, unknown> {
  if (typeof item === "object" && item !== null && "toObject" in item) {
    const doc = item as { toObject: () => Record<string, unknown> };
    if (typeof doc.toObject === "function") {
      return doc.toObject();
    }
  }
  return JSON.parse(JSON.stringify(item)) as Record<string, unknown>;
}

/** §2 col 2: `OTA → "OTA"`, `OTA_PLUS → "OTA Post"`, null → `""`. */
function formatPostingType(jobPlain: Record<string, unknown>): string {
  const pt = jobPlain.posting_type;
  if (pt === PostingType.OTA_PLUS) return "OTA Post";
  if (pt === PostingType.OTA) return "OTA";
  return "";
}

/** §2 col 5: `job.end_date` as `MMM dd, yyyy` (e.g. Feb 28, 2026). */
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

/**
 * §2 col 13 Booking: `payment_info.charge_before` or `"N/A"`.
 * Sample export uses plain `YYYY-MM-DD` when applicable.
 */
function formatChargeBeforeBooking(raw: unknown): string {
  if (raw == null) return "N/A";
  const s = String(raw).trim();
  if (!s) return "N/A";
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    const y = raw.getUTCFullYear();
    const mo = String(raw.getUTCMonth() + 1).padStart(2, "0");
    const d = String(raw.getUTCDate()).padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return s;
}

/** §2 col 4: `job.batch.name` — not on Job schema here; optional loose field. */
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

/** §2 cols 18–20: Excel text-formula `="…"` so Sheets/Excel treat as text. */
function excelTextFormula(inner: string): string {
  if (!inner) return "";
  const escaped = inner.replace(/"/g, '""');
  return `="${escaped}"`;
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

function rowFromItem(
  plain: Record<string, unknown>,
  jobPlain: Record<string, unknown>,
  otaId: string
): Record<BookingMasterHeader, string | number> {
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

  const cardNumRaw = String(card.card_number ?? "").trim();
  const cardNumberCell = cardNumRaw
    ? excelTextFormula(cardNumberGroupedForExport(cardNumRaw))
    : "";

  const expRaw = String(card.expiry_date ?? "").trim();
  const expiryCell = expRaw ? excelTextFormula(expRaw) : "";

  const cvvRaw = String(card.cvv ?? "").trim();
  const cvvCell = cvvRaw ? excelTextFormula(cvvRaw) : "";

  return {
    OTA: "Booking",
    "OTA Posting Type": formatPostingType(jobPlain),
    "OTA ID": otaId,
    Batch: resolveBatchName(jobPlain),
    "Review Collection Date": formatReviewCollectionDate(jobPlain.end_date),
    Portfolio: String(jobPlain.portfolio_name ?? ""),
    "Property Name": String(jobPlain.property_name ?? ""),
    "Reservation ID": String(plain.reservation_id ?? ""),
    "Hotel Confirmation Code": "N/A",
    "Guest name": String(plain.guest_name ?? ""),
    "Check In": "N/A",
    "Check Out": "N/A",
    "Charge Before": formatChargeBeforeBooking(pay.charge_before),
    Currency: currency,
    "Booking Amount": "N/A",
    "Amount to Charge": amountToCharge,
    "Card Status": "N/A",
    "Card Number": cardNumberCell,
    "Expiry date": expiryCell,
    CVV: cvvCell,
    "Due to Property": "",
    "Due to VNP/Invoice": "",
    "Processor (DBMS Based on OTA)": "",
    "QP Username (From DBMS)": "",
    "Case Contact (From DBMS)": "",
    "Reporting Contact (From DBMS)": "",
  };
}

/** Excel / Google Sheets: force text cells for formula-style card fields. */
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

/**
 * Booking.com job_items → XLSX (Google Drive export), aligned with
 * `automated-export.md` §1.2 Booking / §2 matrix (26 columns).
 */
export function jobItemsBookingVccToXlsxBuffer(
  items: unknown[],
  job: IJob,
  property: IProperty | null
): Buffer {
  const jobPlain = jobToPlain(job);
  const otaId =
    property?.booking_id != null ? String(property.booking_id) : "";
  const rows = items.map((item) =>
    rowFromItem(itemToPlain(item), jobPlain, otaId)
  );
  const sheet = XLSX.utils.json_to_sheet(rows, {
    header: [...BOOKING_MASTER_EXPORT_HEADERS],
  });

  for (const h of ["Card Number", "Expiry date", "CVV"] as const) {
    const col = BOOKING_MASTER_EXPORT_HEADERS.indexOf(h);
    if (col >= 0) formatColumnAsText(sheet, col);
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Job items");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
