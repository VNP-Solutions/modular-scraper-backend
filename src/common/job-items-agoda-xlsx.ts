import * as XLSX from "xlsx";
import type { WorkSheet } from "xlsx";
import type { IJobItem } from "../models/job-item.model.js";
import type { IJob } from "../models/job.model.js";
import type { IProperty } from "../models/property.model.js";

/** Column order must match row objects (stable for CVV text-format pass). */
const AGODA_HEADERS = [
  "Portfolio",
  "Property ID",
  "Property Name",
  "Booking ID",
  "Stay Date From",
  "Stay Date To",
  "Guest Name",
  "Currency",
  "Amount to charge / remaining",
  "Reservation status",
  "Card number",
  "Expiry",
  "CVV",
] as const;

/** Excel / Google Sheets: text format so CVV keeps leading zeros and `0`. */
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

function fmtYmd(d: Date | undefined): string {
  if (!d || !(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  return d.toISOString().split("T")[0];
}

/**
 * Charge / export sheet for Agoda job_items (aligned with internal CSV-style fields where useful).
 */
export function jobItemsAgodaToXlsxBuffer(
  items: IJobItem[],
  job: IJob,
  property: IProperty | null
): Buffer {
  const agodaPropertyId = property?.agoda_id?.trim() ?? "";

  const rows = items.map((item) => ({
    Portfolio: job.portfolio_name ?? "",
    "Property ID": agodaPropertyId,
    "Property Name": job.property_name ?? "",
    "Booking ID": item.reservation_id ?? "",
    "Stay Date From": fmtYmd(item.check_in_date as Date),
    "Stay Date To": fmtYmd(item.check_out_date as Date),
    "Guest Name": item.guest_name ?? "",
    Currency: item.payment_info?.amount_to_charge_or_refund_currency ?? "USD",
    "Amount to charge / remaining": item.payment_info?.amount_to_charge_or_refund ?? 0,
    "Reservation status": item.reservation_status ?? "",
    "Card number":
      item.has_card_info && item.card_info?.card_number
        ? item.card_info.card_number
        : "",
    Expiry:
      item.has_card_info && item.card_info?.expiry_date
        ? item.card_info.expiry_date
        : "",
    CVV: item.has_card_info
      ? String(item.card_info?.cvv ?? "")
      : "",
  }));

  const ws = XLSX.utils.json_to_sheet(rows, {
    header: [...AGODA_HEADERS],
  });
  const cvvCol = AGODA_HEADERS.indexOf("CVV");
  if (cvvCol >= 0) {
    formatColumnAsText(ws, cvvCol);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Job items");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}
