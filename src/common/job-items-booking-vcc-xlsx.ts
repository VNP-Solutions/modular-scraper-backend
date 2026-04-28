import XLSX from "xlsx";
import type { WorkSheet } from "xlsx";
import type { IJob } from "../models/job.model.js";
import type { IProperty } from "../models/property.model.js";

const BOOKING_VCC_HEADERS = [
  "Hotel ID",
  "Portfolio",
  "Hotel Name",
  "Reservation ID",
  "Currency",
  "Amount Collected",
  "Card Number",
  "Exp Date",
  "CVV",
  "Card Holder Name",
  "Charge Before",
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

function formatSheetDate(raw: unknown): string {
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
  hotelId: string
): Record<(typeof BOOKING_VCC_HEADERS)[number], string | number> {
  const card = (plain.card_info as Record<string, unknown>) || {};
  const pay = (plain.payment_info as Record<string, unknown>) || {};
  const amount =
    pay.total_guest_payment != null
      ? Number(pay.total_guest_payment)
      : plain.booking_amount != null
        ? Number(plain.booking_amount)
        : "";

  /** VCC "Charge Before" = payment deadline from Booking (`payment_info.charge_before`), not checkout. */
  const chargeBeforeRaw = pay.charge_before;

  return {
    "Hotel ID": hotelId,
    Portfolio: job.portfolio_name ?? "",
    "Hotel Name": job.property_name ?? "",
    "Reservation ID": String(plain.reservation_id ?? ""),
    Currency: String(pay.amount_to_charge_or_refund_currency ?? ""),
    "Amount Collected": amount === "" ? "" : amount,
    "Card Number": String(card.card_number ?? ""),
    "Exp Date": String(card.expiry_date ?? ""),
    CVV: String(card.cvv ?? ""),
    "Card Holder Name": String(card.card_holder_name ?? ""),
    "Charge Before": formatSheetDate(chargeBeforeRaw),
  };
}

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

/**
 * Booking.com VCC job_items → XLSX (Google Drive export).
 */
export function jobItemsBookingVccToXlsxBuffer(
  items: unknown[],
  job: IJob,
  property: IProperty | null
): Buffer {
  const hotelId =
    property?.booking_id != null ? String(property.booking_id) : "";
  const rows = items.map((item) =>
    rowFromItem(itemToPlain(item), job, hotelId)
  );
  const sheet = XLSX.utils.json_to_sheet(rows, {
    header: [...BOOKING_VCC_HEADERS],
  });
  const cvvCol = BOOKING_VCC_HEADERS.indexOf("CVV");
  if (cvvCol >= 0) {
    formatColumnAsText(sheet, cvvCol);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Job items");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
