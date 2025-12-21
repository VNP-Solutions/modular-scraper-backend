import { Page } from "puppeteer";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";

export interface InvoiceRowData {
  reservation_id: string;
  invoice_id: string;
  guest_name: string;
  check_in_date: string;
  check_out_date: string;
  previously_paid_amount: number;
  previously_paid_amount_currency: string;
  maximum_billable_amount: number;
  maximum_billable_amount_currency: string;
  requested_booking_amount: number;
  requested_taxes: number;
  requested_total: number;
  requested_total_currency: string;
}

/**
 * Extract all row data from the invoice table
 * This function extracts data from each row in the invoice-details-table
 */
export async function extractInvoiceRows(
  page: Page,
  jobId?: string
): Promise<InvoiceRowData[]> {
  try {
    await dualLogInfo("Starting invoice row extraction...", { jobId });

    // Wait for the invoice table to be present
    const tableExists = await page
      .waitForSelector("#invoice-details-table", {
        visible: true,
        timeout: 10000,
      })
      .then(() => true)
      .catch(() => false);

    if (!tableExists) {
      await dualLogInfo("Invoice table not found, returning empty array", {
        jobId,
      });
      return [];
    }

    await dualLogInfo("Invoice table found, extracting row data...", { jobId });

    // Extract all row data from the table
    const rowsData = await page.evaluate(() => {
      const rows = document.querySelectorAll("#invoice-details-table tbody tr");
      const extractedRows: InvoiceRowData[] = [];

      rows.forEach((row, index) => {
        try {
          // Helper function to extract currency and amount from text
          const extractAmountAndCurrency = (
            text: string
          ): { amount: number; currency: string } => {
            if (!text) return { amount: 0, currency: "USD" };

            // Extract currency code (e.g., "USD", "EUR")
            const currencyMatchStart = text.match(/^([A-Z]{3})\s/);
            const currencyMatchEnd = text.match(/\s([A-Z]{3})$/);
            const currency =
              currencyMatchStart?.[1] || currencyMatchEnd?.[1] || "USD";

            // Extract numeric value
            const amountMatch = text.match(/-?[\d,]+\.?\d*/);
            let amount = 0;
            if (amountMatch) {
              const cleanedAmount = amountMatch[0].replace(/,/g, "");
              amount = parseFloat(cleanedAmount) || 0;
            }

            return { amount, currency };
          };

          // Helper function to parse date string (MM/DD/YYYY or DD/MM/YYYY)
          const parseDateString = (dateStr: string): string => {
            if (!dateStr) return "";
            // Try to parse and return in ISO format
            const date = new Date(dateStr);
            if (!isNaN(date.getTime())) {
              return date.toISOString();
            }
            return dateStr;
          };

          // Extract Reservation ID - try multiple selectors
          let reservationIdTd =
            row.querySelector('td[data-title="Reservation ID"]') ||
            row.querySelector('td[data-title="Reservation"]') ||
            row.querySelector("td.reservationId");
          const reservation_id =
            reservationIdTd?.textContent?.trim() || `RES-${index}`;

          // Extract Invoice ID (might be same as reservation ID or separate)
          let invoiceIdTd =
            row.querySelector('td[data-title="Invoice ID"]') ||
            row.querySelector('td[data-title="Invoice"]') ||
            row.querySelector("td.invoiceId");
          const invoice_id = invoiceIdTd?.textContent?.trim() || reservation_id;

          // Extract Guest Name - try multiple selectors
          let guestNameTd =
            row.querySelector('td[data-title="Guest Name"]') ||
            row.querySelector('td[data-title="Guest"]') ||
            row.querySelector("td.guestName");
          const guest_name = guestNameTd?.textContent?.trim() || "";

          // Extract Check-in Date - try multiple selectors
          let checkInTd =
            row.querySelector('td[data-title="Check-in"]') ||
            row.querySelector('td[data-title="Check In"]') ||
            row.querySelector("td.checkInDate");
          const check_in_date = parseDateString(
            checkInTd?.textContent?.trim() || ""
          );

          // Extract Check-out Date - try multiple selectors
          let checkOutTd =
            row.querySelector('td[data-title="Check-out"]') ||
            row.querySelector('td[data-title="Check Out"]') ||
            row.querySelector("td.checkOutDate");
          const check_out_date = parseDateString(
            checkOutTd?.textContent?.trim() || ""
          );

          // Extract Previously Paid Amount - try multiple selectors
          let previouslyPaidTd =
            row.querySelector('td[data-title="Previously Paid Amount"]') ||
            row.querySelector('td[data-title="Previously Paid"]') ||
            row.querySelector("td.previouslyPaid");
          const previouslyPaidText =
            previouslyPaidTd?.textContent?.trim() || "";
          const previouslyPaid = extractAmountAndCurrency(previouslyPaidText);

          // Extract Max. Billable Amount - try multiple selectors
          let billableAmountTd =
            row.querySelector('td[data-title="Max. Billable Amount"]') ||
            row.querySelector('td[data-title="Maximum Billable Amount"]') ||
            row.querySelector('td[data-title="Billable Amount"]') ||
            row.querySelector("td.billableAmount");
          const billableAmountText =
            billableAmountTd?.textContent?.trim() || "";
          const billableAmount = extractAmountAndCurrency(billableAmountText);

          // Helper function to round to 2 decimal places
          const roundToTwoDecimals = (value: number): number => {
            return Math.round(value * 100) / 100;
          };

          // Extract Requested Booking Amount (from input)
          const bookingAmountInput = row.querySelector(
            "input.bookingAmount"
          ) as HTMLInputElement;
          const requestedBookingAmountText =
            bookingAmountInput?.value.trim() || "0";
          const requestedBookingAmount = roundToTwoDecimals(
            parseFloat(requestedBookingAmountText.replace(/,/g, "")) || 0
          );

          // Extract Requested Taxes (from input)
          const taxAmountInput = row.querySelector(
            "input.taxAmount"
          ) as HTMLInputElement;
          const requestedTaxesText = taxAmountInput?.value.trim() || "0";
          const requestedTaxes = roundToTwoDecimals(
            parseFloat(requestedTaxesText.replace(/,/g, "")) || 0
          );

          // Calculate Requested Total (rounded to 2 decimal places)
          const requestedTotal = roundToTwoDecimals(
            requestedBookingAmount + requestedTaxes
          );

          // Get currency from billable amount or default to USD
          const requestedTotalCurrency =
            billableAmount.currency || previouslyPaid.currency || "USD";

          extractedRows.push({
            reservation_id,
            invoice_id,
            guest_name,
            check_in_date,
            check_out_date,
            previously_paid_amount: previouslyPaid.amount,
            previously_paid_amount_currency: previouslyPaid.currency,
            maximum_billable_amount: billableAmount.amount,
            maximum_billable_amount_currency: billableAmount.currency,
            requested_booking_amount: requestedBookingAmount,
            requested_taxes: requestedTaxes,
            requested_total: requestedTotal,
            requested_total_currency: requestedTotalCurrency,
          });
        } catch (rowError) {
          console.error(`Error extracting row ${index}:`, rowError);
        }
      });

      return extractedRows;
    });

    await dualLogInfo(
      `Extracted ${rowsData.length} row(s) from invoice table`,
      { jobId, rowCount: rowsData.length }
    );

    return rowsData;
  } catch (error: any) {
    await dualLogError("Error extracting invoice rows:", error, { jobId });
    return [];
  }
}
