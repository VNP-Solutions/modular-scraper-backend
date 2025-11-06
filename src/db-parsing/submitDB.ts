import { Page } from "puppeteer";
import { BROWSER_CONFIG } from "../common/browser-constants.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";

/**
 * Helper function to convert ISO date to MM-DD-YYYY format
 * Example: "2025-09-29T00:00:00Z" → "09-29-2025"
 */
function convertToMMDDYYYY(isoDateStr: string): string {
  if (!isoDateStr) return "";

  const date = new Date(isoDateStr);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const year = date.getFullYear();

  return `${month}-${day}-${year}`;
}

/**
 * Submit invoice data to Expedia via createInvoice API
 * This function processes reservation data and submits invoices
 */
export async function submitInvoice(
  page: Page,
  expediaId: string,
  reservations: any[],
  jobId?: string
): Promise<any> {
  try {
    await dualLogInfo("📝 Starting invoice submission...", {
      expediaId,
      reservationCount: reservations.length,
      jobId,
    });

    if (!reservations || reservations.length === 0) {
      await dualLogInfo("⚠️ No reservations to submit");
      return { success: true, message: "No reservations to process" };
    }

    // Build invoice data array
    const invoiceData = reservations.map((reservation, index) => {
      // Determine InvoiceAmt based on PaidAmount existence
      let invoiceAmt: number;

      if (
        reservation.PaidAmount === undefined ||
        reservation.PaidAmount === null
      ) {
        // PaidAmount doesn't exist → use StayLevelCost + StayLevelTaxes
        invoiceAmt =
          (reservation.StayLevelCost || 0) + (reservation.StayLevelTaxes || 0);
      } else {
        // PaidAmount exists → use BillableAmount
        invoiceAmt = reservation.BillableAmount || 0;
      }

      return {
        checked: true,
        BookingItemId: reservation.BookingItemId || "",
        SupplierBookingConfirmationCode:
          reservation.SupplierBookingConfirmationCode || "",
        StayLevelCost: reservation.StayLevelCost || 0,
        StayLevelTaxes: reservation.StayLevelTaxes || 0,
        PrimaryTravelerFullName: reservation.PrimaryTravelerFullName || "",
        UseDateBegin: convertToMMDDYYYY(reservation.UseDateBegin),
        UseDateEnd: convertToMMDDYYYY(reservation.UseDateEnd),
        BillableAmount: reservation.BillableAmount || 0,
        PaidAmount: reservation.PaidAmount,
        Status: reservation.Status || "Booked",
        EvcBooking: reservation.EvcBooking || false,
        CurrencyCode: reservation.CurrencyCode || "USD",
        InvoiceAmt: invoiceAmt,
        rowNum: index,
        VendorInvoiceNumber: "",
        invalidAmountsError: false,
      };
    });

    // Log the invoice amounts after mapping
    invoiceData.forEach((invoice, index) => {
      const reservation = reservations[index];
      if (
        reservation.PaidAmount === undefined ||
        reservation.PaidAmount === null
      ) {
        dualLogInfo(
          `💰 Reservation ${
            index + 1
          }: PaidAmount not found, using StayLevelCost (${
            reservation.StayLevelCost
          }) + StayLevelTaxes (${reservation.StayLevelTaxes}) = ${
            invoice.InvoiceAmt
          }`
        );
      } else {
        dualLogInfo(
          `💰 Reservation ${
            index + 1
          }: PaidAmount exists, using BillableAmount: ${invoice.InvoiceAmt}`
        );
      }
    });

    await dualLogInfo(
      `✅ Built invoice data for ${invoiceData.length} reservations`
    );

    // Build the API URL
    const apiUrl = `https://apps.expediapartnercentral.com/lodging/finance/createInvoice.json?htid=${expediaId}`;

    await dualLogInfo(`🔗 Submitting to API: ${apiUrl}`);

    // Make the API call using page.evaluate (runs in browser context)
    const responseData = await page.evaluate(
      async (url, invoiceData, userAgent) => {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            accept: "application/json, text/javascript, */*; q=0.01",
            "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
            "content-type": "application/json",
            "sec-ch-ua":
              '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"macOS"',
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
            "user-agent": userAgent,
            "x-requested-with": "XMLHttpRequest",
            referer: `https://apps.expediapartnercentral.com/lodging/finance/ecInvoiceManualCreate.html?htid=${
              url.split("htid=")[1]?.split("&")[0] || ""
            }`,
            origin: "https://apps.expediapartnercentral.com",
            priority: "u=1, i",
          },
          body: JSON.stringify({ invoiceData }),
          credentials: "include",
        });

        if (!response.ok) {
          throw new Error(
            `Invoice submission failed with status: ${response.status} ${response.statusText}`
          );
        }

        return await response.json();
      },
      apiUrl,
      invoiceData,
      BROWSER_CONFIG.USER_AGENT
    );

    await dualLogInfo("✅ Invoice submission completed successfully");
    await dualLogInfo(`📊 Response:`, responseData);

    return {
      success: true,
      response: responseData,
      submittedCount: invoiceData.length,
    };
  } catch (error: any) {
    await dualLogError("❌ Error submitting invoice:", error, {
      jobId,
      expediaId,
      reservationCount: reservations?.length || 0,
    });
    throw error;
  }
}
