import * as XLSX from "xlsx";
import type { IJobItem } from "../models/job-item.model.js";
import type { IJob } from "../models/job.model.js";
import type { IProperty } from "../models/property.model.js";

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
    "Property Id (Agoda)": agodaPropertyId,
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
    CVV: item.has_card_info && item.card_info?.cvv ? item.card_info.cvv : "",
    "Reason for charge":
      item.has_card_info && item.card_info?.reason_for_charge
        ? item.card_info.reason_for_charge
        : "",
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Job items");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}
