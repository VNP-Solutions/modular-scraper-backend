import XLSX from "xlsx";
import type { WorkSheet } from "xlsx";
import type { IJob } from "../models/job.model.js";
import type { IProperty } from "../models/property.model.js";

const CHARGE_REPORT_HEADERS = [
  "Expedia ID",
  "Portfolio",
  "Hotel Name",
  "Reservation ID",
  "Hotel Confirmation Code",
  "Name",
  "Check-in",
  "Check-out",
  "Currency",
  "Booking Amount",
  "Amount to charge",
  "Reason for charge",
  "Card Number",
  "Expiry Date",
  "CVV",
] as const;

function itemToPlain(item: unknown): Record<string, unknown> {
  if (typeof item === "object" && item !== null && "toObject" in item) {
    const doc = item as { toObject: () => Record<string, unknown> };
    if (typeof doc.toObject === "function") {
      return doc.toObject();
    }
  }
  return JSON.parse(JSON.stringify(item)) as Record<string, unknown>;
}

/** e.g. Feb 27, 2026 (UTC calendar date from stored value). */
function formatDateForSheet(raw: unknown): string {
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

function rowFromItem(
  plain: Record<string, unknown>,
  job: IJob,
  property: IProperty | null
): Record<(typeof CHARGE_REPORT_HEADERS)[number], string | number> {
  const card = (plain.card_info as Record<string, unknown>) || {};
  const pay = (plain.payment_info as Record<string, unknown>) || {};
  const expediaId =
    property?.expedia_id != null ? String(property.expedia_id) : "";

  const bookingAmount =
    plain.booking_amount != null ? Number(plain.booking_amount) : "";
  const amountToCharge =
    pay.amount_to_charge_or_refund != null
      ? Number(pay.amount_to_charge_or_refund)
      : "";

  return {
    "Expedia ID": expediaId,
    Portfolio: job.portfolio_name ?? "",
    "Hotel Name": job.property_name ?? "",
    "Reservation ID": String(plain.reservation_id ?? ""),
    "Hotel Confirmation Code": String(plain.confirmation_number ?? ""),
    Name: String(plain.guest_name ?? ""),
    "Check-in": formatDateForSheet(plain.check_in_date),
    "Check-out": formatDateForSheet(plain.check_out_date),
    Currency: String(pay.amount_to_charge_or_refund_currency ?? ""),
    "Booking Amount": bookingAmount === "" ? "" : bookingAmount,
    "Amount to charge": amountToCharge === "" ? "" : amountToCharge,
    "Reason for charge": String(card.reason_for_charge ?? ""),
    "Card Number": String(card.card_number ?? ""),
    "Expiry Date": String(card.expiry_date ?? ""),
    CVV: String(card.cvv ?? ""),
  };
}

/** Excel text format so values (e.g. leading zeros) are not coerced to numbers. */
const EXCEL_TEXT_FORMAT = "@";

/**
 * Apply `@` (Text) format to every cell in a column so Excel treats the column as text.
 */
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
 * XLSX workbook buffer: Expedia-style charge report for Google Drive upload.
 */
export function jobItemsToChargeReportXlsxBuffer(
  items: unknown[],
  job: IJob,
  property: IProperty | null
): Buffer {
  const rows = items.map((item) =>
    rowFromItem(itemToPlain(item), job, property)
  );
  const sheet = XLSX.utils.json_to_sheet(rows, {
    header: [...CHARGE_REPORT_HEADERS],
  });
  const cvvCol = CHARGE_REPORT_HEADERS.indexOf("CVV");
  if (cvvCol >= 0) {
    formatColumnAsText(sheet, cvvCol);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Job items");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
