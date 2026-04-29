import XLSX from "xlsx";
import type { WorkSheet } from "xlsx";
import type { IJobItem } from "../models/job-item.model.js";
import { PostingType, type IJob } from "../models/job.model.js";
import type { IProperty } from "../models/property.model.js";

/**
 * Agoda master export — exactly 26 columns per `automated-export.md` §1.3 / §3 (Agoda).
 * No Card Activity / Calculated / Amount Match / Approved Amount columns.
 */

const AGODA_MASTER_HEADERS = [
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

type AgodaMasterHeader = (typeof AGODA_MASTER_HEADERS)[number];

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

/** §2 col 5 / Agoda cols 11–12: `MMM dd, yyyy` (UTC calendar date). */
function formatMasterDateMmDdYyyy(raw: unknown): string {
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
): Record<AgodaMasterHeader, string | number> {
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

  const hasCard =
    plain.has_card_info === true ||
    (card.card_number != null && String(card.card_number).trim() !== "");
  const cardNumRaw = hasCard ? String(card.card_number ?? "").trim() : "";
  const cardNumberCell = cardNumRaw
    ? cardNumberGroupedForExport(cardNumRaw)
    : "";

  const expiryCell = hasCard ? String(card.expiry_date ?? "").trim() : "";
  const cvvCell = hasCard ? String(card.cvv ?? "").trim() : "";

  return {
    OTA: "Agoda",
    "OTA Posting Type": formatPostingType(jobPlain),
    "OTA ID": otaId,
    Batch: resolveBatchName(jobPlain),
    "Review Collection Date": formatMasterDateMmDdYyyy(jobPlain.end_date),
    Portfolio: String(jobPlain.portfolio_name ?? ""),
    "Property Name": String(jobPlain.property_name ?? ""),
    "Reservation ID": String(plain.reservation_id ?? ""),
    "Hotel Confirmation Code": "N/A",
    "Guest name": String(plain.guest_name ?? ""),
    "Check In": formatMasterDateMmDdYyyy(plain.check_in_date),
    "Check Out": formatMasterDateMmDdYyyy(plain.check_out_date),
    "Charge Before": "N/A",
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
 * Agoda `job_items` → XLSX for Google Drive (`automated-export.md` §1.3 Agoda).
 */
export function jobItemsAgodaToXlsxBuffer(
  items: IJobItem[],
  job: IJob,
  property: IProperty | null
): Buffer {
  const jobPlain = jobToPlain(job);
  const otaId =
    property?.agoda_id != null && String(property.agoda_id).trim() !== ""
      ? String(property.agoda_id).trim()
      : "";

  const rows = items.map((item) =>
    rowFromItem(itemToPlain(item), jobPlain, otaId)
  );

  const sheet = XLSX.utils.json_to_sheet(rows, {
    header: [...AGODA_MASTER_HEADERS],
  });

  for (const h of ["Card Number", "Expiry date", "CVV"] as const) {
    const col = AGODA_MASTER_HEADERS.indexOf(h);
    if (col >= 0) formatColumnAsText(sheet, col);
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Job items");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
