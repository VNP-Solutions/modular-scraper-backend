import { Browser, Page } from "puppeteer";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { dbDataService } from "../services/db-data.service.js";
import { makeDBApiRequest } from "./makeDBApiRequest.js";
import { submitInvoice } from "./submitDB.js";

export async function getDBData(
  browser: Browser,
  page: Page,
  expediaId?: string,
  startDate?: string,
  endDate?: string,
  jobId?: string
): Promise<void> {
  try {
    await dualLogInfo("🔍 Starting DB data parsing...", {
      expediaId,
      startDate,
      endDate,
      jobId,
    });

    // Helper function to parse MM/DD/YYYY date format
    const parseDate = (dateStr: string): Date => {
      const [month, day, year] = dateStr.split("/").map(Number);
      return new Date(year, month - 1, day);
    };

    // Helper function to format date back to MM/DD/YYYY
    const formatDate = (date: Date): string => {
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      const year = date.getFullYear();
      return `${month}/${day}/${year}`;
    };

    // Helper function to get the last day of a month
    const getLastDayOfMonth = (date: Date): number => {
      return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    };

    // Helper function to add days to a date
    const addDays = (date: Date, days: number): Date => {
      const result = new Date(date);
      result.setDate(result.getDate() + days);
      return result;
    };

    // Parse start and end dates
    const overallStartDate = parseDate(startDate!);
    const overallEndDate = parseDate(endDate!);

    await dualLogInfo("📅 Date range splitting logic starting...", {
      startDate,
      endDate,
      totalDays: Math.ceil(
        (overallEndDate.getTime() - overallStartDate.getTime()) /
          (1000 * 60 * 60 * 24)
      ),
    });

    // Split date range into chunks
    const dateChunks: { start: string; end: string }[] = [];
    let currentStart = new Date(overallStartDate);

    while (currentStart <= overallEndDate) {
      let chunkEnd: Date;

      // Check if we're at the 1st of the month
      if (currentStart.getDate() === 1) {
        // Take the whole month
        const lastDayOfMonth = getLastDayOfMonth(currentStart);
        chunkEnd = new Date(
          currentStart.getFullYear(),
          currentStart.getMonth(),
          lastDayOfMonth
        );
        await dualLogInfo(
          `📆 Starting from 1st of month, taking full month (${lastDayOfMonth} days)`
        );
      } else {
        // Take up to 31 days or 30 days
        chunkEnd = addDays(currentStart, 30); // Using 30 days for non-month-start
      }

      // Make sure chunk end doesn't exceed overall end date
      if (chunkEnd > overallEndDate) {
        chunkEnd = new Date(overallEndDate);
      }

      const chunk = {
        start: formatDate(currentStart),
        end: formatDate(chunkEnd),
      };
      dateChunks.push(chunk);

      await dualLogInfo(
        `📋 Created date chunk: ${chunk.start} to ${chunk.end}`
      );

      // Move to next chunk (day after chunk end)
      currentStart = addDays(chunkEnd, 1);
    }

    await dualLogInfo(
      `✅ Date range split into ${dateChunks.length} chunks`,
      dateChunks
    );

    // Loop through each date chunk and process
    for (let i = 0; i < dateChunks.length; i++) {
      const chunk = dateChunks[i];
      const chunkNumber = i + 1;
      const totalChunks = dateChunks.length;

      await dualLogInfo(
        `🔄 Processing chunk ${chunkNumber}/${totalChunks}: ${chunk.start} to ${chunk.end}`,
        {
          chunkNumber,
          totalChunks,
          chunkStart: chunk.start,
          chunkEnd: chunk.end,
          expediaId,
          jobId,
        }
      );

      try {
        // Make DB API request for this chunk
        const responseData = await makeDBApiRequest(
          page,
          expediaId!,
          chunk.start,
          chunk.end,
          jobId
        );

        await dualLogInfo(
          `📦 Received data for chunk ${chunkNumber}/${totalChunks}`,
          {
            dataKeys: Object.keys(responseData || {}),
            hasData: !!responseData,
          }
        );

        // Check if we have reservations in the response
        let reservations: any[] = [];

        if (Array.isArray(responseData)) {
          // If responseData is directly an array of reservations
          reservations = responseData;
        } else if (responseData && Array.isArray(responseData.reservations)) {
          // If reservations are nested in a property
          reservations = responseData.reservations;
        } else if (responseData && typeof responseData === "object") {
          // If it's an object, try to find array properties
          const arrayKeys = Object.keys(responseData).filter((key) =>
            Array.isArray(responseData[key])
          );
          if (arrayKeys.length > 0) {
            reservations = responseData[arrayKeys[0]];
          }
        }

        await dualLogInfo(
          `📊 Found ${reservations.length} reservations in chunk ${chunkNumber}/${totalChunks}`
        );

        if (reservations.length > 0) {
          // Extract reservation IDs (BookingItemId)
          const reservationIds = reservations
            .map((r) => r.BookingItemId)
            .filter((id) => id); // Filter out any undefined/null IDs

          await dualLogInfo(
            `📝 Extracted ${reservationIds.length} reservation IDs from chunk ${chunkNumber}/${totalChunks}`
          );

          // Save reservation IDs to database
          try {
            const dbData = await dbDataService.createDbData({
              job_id: jobId!,
              property_name: expediaId || "Unknown Property",
              property_id: expediaId || "",
              date_range: {
                start_date: chunk.start,
                end_date: chunk.end,
              },
              gearbox_queue_ids: [],
            });

            await dualLogInfo(
              `✅ Saved ${reservationIds.length} reservation IDs to database`,
              {
                dbRecordId: dbData._id.toString(),
                reservationCount: reservationIds.length,
              }
            );
          } catch (dbError: any) {
            await dualLogError(
              `❌ Failed to save reservation IDs to database:`,
              dbError,
              {
                jobId,
                reservationCount: reservationIds.length,
              }
            );
            // Continue even if DB save fails
          }

          // Call the invoice submission API for these reservations
          await dualLogInfo(
            `📤 Submitting ${reservations.length} invoices to Expedia...`
          );

          try {
            const invoiceResult = await submitInvoice(
              page,
              expediaId!,
              reservations,
              jobId
            );

            await dualLogInfo(
              `✅ Invoice submission successful for chunk ${chunkNumber}/${totalChunks}`,
              {
                submittedCount: invoiceResult.submittedCount,
                response: invoiceResult.response,
              }
            );
          } catch (invoiceError: any) {
            await dualLogError(
              `❌ Invoice submission failed for chunk ${chunkNumber}/${totalChunks}:`,
              invoiceError,
              {
                reservationCount: reservations.length,
                expediaId,
                jobId,
              }
            );
            // Continue processing even if invoice submission fails
            await dualLogInfo(
              `⚠️ Continuing despite invoice submission error...`
            );
          }
        } else {
          await dualLogInfo(
            `ℹ️ No reservations to submit for chunk ${chunkNumber}/${totalChunks}`
          );
        }

        await dualLogInfo(
          `✅ Completed processing chunk ${chunkNumber}/${totalChunks}`
        );
      } catch (chunkError: any) {
        await dualLogError(
          `❌ Error processing chunk ${chunkNumber}/${totalChunks}:`,
          chunkError,
          {
            chunkStart: chunk.start,
            chunkEnd: chunk.end,
            expediaId,
            jobId,
          }
        );

        // Decide whether to continue or stop on error
        // For now, we'll log the error and continue with next chunk
        await dualLogInfo(
          `⚠️ Skipping chunk ${chunkNumber}/${totalChunks} due to error, continuing with next chunk...`
        );
      }
    }

    await dualLogInfo(
      "✅ DB data parsing completed successfully for all chunks"
    );
  } catch (error) {
    await dualLogError("❌ Error in DB data parsing:", error);
    throw error;
  }
}
