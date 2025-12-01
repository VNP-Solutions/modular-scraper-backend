import { Browser, Page } from "puppeteer";
import { delay } from "../../common/delay.js";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { progressManager } from "../../common/progress-manager.js";
import { scrapingStateManager } from "../../common/scraping-state.js";
import { takeSuccessScreenshot } from "../../common/screenshot-helper.js";
import { timeoutManager } from "../../common/timeout-manager.js";
import { searchBookingAndNavigateToPayout } from "../retriveal-data/retriveal-data.js";
import { PAGE_LOADING, RESERVATIONS_PAGE } from "../utils/selectors.js";

// Interface for reservation data
interface Reservation {
  id: string;
  idList: string[];
}

/**
 * Converts date from YYYY-MM-DD format to DD-MM-YYYY format
 * @param dateString - Date in YYYY-MM-DD format (e.g., "2024-01-31")
 * @returns Date in DD-MM-YYYY format (e.g., "31-01-2024")
 */
function convertDateFormat(dateString: string): string {
  // Handle both YYYY-MM-DD and MM/DD/YYYY formats for backward compatibility
  let year: string, month: string, day: string;

  if (dateString.includes("/")) {
    // MM/DD/YYYY format
    const parts = dateString.split("/");
    month = parts[0].padStart(2, "0");
    day = parts[1].padStart(2, "0");
    year = parts[2];
  } else if (dateString.includes("-")) {
    // YYYY-MM-DD format
    const parts = dateString.split("-");
    year = parts[0];
    month = parts[1].padStart(2, "0");
    day = parts[2].padStart(2, "0");
  } else {
    throw new Error(`Unsupported date format: ${dateString}`);
  }

  return `${day}-${month}-${year}`;
}

/**
 * Calculates date range for Agoda retrieval booking data
 * End date: Today's date
 * Start date: 1 year before end date
 * @returns Object with startDate and endDate in MM/DD/YYYY format
 */
function calculateRetrievalDateRange(): { startDate: string; endDate: string } {
  // Get today's date
  const today = new Date();

  // Calculate 1 year before today
  const oneYearAgo = new Date(today);
  oneYearAgo.setFullYear(today.getFullYear() - 1);

  // Format dates as MM/DD/YYYY
  const formatDate = (date: Date): string => {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const year = date.getFullYear();
    return `${month}/${day}/${year}`;
  };

  return {
    startDate: formatDate(oneYearAgo),
    endDate: formatDate(today),
  };
}

export async function getAgodaRetrivealData(
  browser: Browser,
  page: Page,
  agodaId: string,
  jobId?: string,
  reservations?: Reservation[],
  agodaUsername?: string
): Promise<any[]> {
  let newPage: Page | undefined;
  let client: any;

  try {
    // Check if scraping is paused before starting
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogError("Scraping was stopped during booking data retrieval");
      throw new Error("Scraping was stopped during booking data retrieval");
    }

    // Get timeout configuration for this job
    const selectorTimeout = await timeoutManager.getSelectorTimeout(jobId);
    const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);

    // Update progress
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        10,
        "agoda_booking_data_retrieval",
        undefined
      );
    }

    // Calculate date range (end date = today, start date = 1 year before)
    const { startDate, endDate } = calculateRetrievalDateRange();

    // Convert dates to DD-MM-YYYY format required by Agoda API
    const formattedStartDate = convertDateFormat(startDate);
    const formattedEndDate = convertDateFormat(endDate);

    console.log(
      "\x1b[34m%s\x1b[0m",
      `Start Date: ${formattedStartDate}, End Date: ${formattedEndDate}`
    );

    // Construct the booking URL with agoda_id and date range using converted dates
    const bookingUrl = `https://ycs.agoda.com/mldc/en-us/app/reporting/booking/${agodaId}?startDate=${formattedStartDate}&endDate=${formattedEndDate}`;
    await dualLogInfo(`Navigating to booking data URL: ${bookingUrl}`);

    await delay(5000);

    // Navigate to the booking data page
    const newPage = await browser.newPage();

    let navigationAttempts = 0;
    const maxNavigationAttempts = 3;
    let reservationsFound = false;

    while (navigationAttempts < maxNavigationAttempts && !reservationsFound) {
      navigationAttempts++;

      await dualLogInfo(
        `Navigation attempt ${navigationAttempts}/${maxNavigationAttempts} to booking data URL: ${bookingUrl}`
      );

      await newPage.goto(bookingUrl, {
        waitUntil: "networkidle2",
        timeout: loadingTimeout,
      });

      await newPage.waitForSelector(PAGE_LOADING.BODY, {
        timeout: loadingTimeout,
      });

      // Wait for the page to load completely
      await delay(5000);

      // Check for "Reservations" text on the page
      try {
        await dualLogInfo("Checking for 'Reservations' text on the page...");

        // Look for the Reservations heading using multiple selectors
        let reservationsElement = null;

        // Try to find the reservations element using different approaches
        for (const selector of RESERVATIONS_PAGE.SELECTORS) {
          try {
            // First try with Puppeteer's built-in selector
            if (
              selector.includes(":has-text") ||
              selector.includes(":contains")
            ) {
              // Use evaluate for text-based selectors
              reservationsElement = await newPage.evaluate(
                (h2Selector, searchText) => {
                  const headings = Array.from(
                    document.querySelectorAll(h2Selector)
                  );
                  return (
                    headings.find(
                      (h) => h.textContent?.trim() === searchText
                    ) || null
                  );
                },
                PAGE_LOADING.H2_HEADING,
                RESERVATIONS_PAGE.TEXT
              );
            } else {
              // Use regular selector
              reservationsElement = await newPage.$(selector);
            }

            if (reservationsElement) {
              await dualLogInfo(
                `Found Reservations element with selector: ${selector}`
              );
              break;
            }
          } catch (selectorError) {
            // Continue to next selector
            continue;
          }
        }

        // Alternative approach: search for "Reservations" text in the page content
        if (!reservationsElement) {
          const pageText = await newPage.evaluate(
            (searchText) =>
              document.body.textContent?.includes(searchText) || false,
            RESERVATIONS_PAGE.TEXT
          );
          if (pageText) {
            await dualLogInfo("Found 'Reservations' text in page content");
            reservationsElement = true; // Mark as found
          }
        }

        if (reservationsElement) {
          reservationsFound = true;
          console.log(
            "\x1b[32m%s\x1b[0m",
            "✅ Reservations text found - page loaded successfully!"
          );
          await dualLogInfo(
            "✅ Reservations text found - page loaded successfully!"
          );
          break;
        } else {
          await dualLogInfo(
            `❌ Reservations text not found on attempt ${navigationAttempts}`
          );

          if (navigationAttempts < maxNavigationAttempts) {
            await dualLogInfo(`Retrying navigation in 3 seconds...`);
            await delay(3000);
          }
        }
      } catch (checkError: any) {
        await dualLogError(
          `Error checking for Reservations text on attempt ${navigationAttempts}:`,
          checkError.message
        );

        if (navigationAttempts < maxNavigationAttempts) {
          await dualLogInfo(`Retrying navigation due to check error...`);
          await delay(3000);
        }
      }
    }

    // Final validation
    if (!reservationsFound) {
      const errorMessage = `Failed to find 'Reservations' text after ${maxNavigationAttempts} navigation attempts`;
      await dualLogError(errorMessage);
      throw new Error(errorMessage);
    }

    await dualLogInfo(
      "Successfully navigated to booking data page and confirmed Reservations section"
    );

    // Take screenshot after successful navigation to booking data page
    if (jobId) {
      await takeSuccessScreenshot(newPage, jobId, "booking_page_loaded");
    }

    // Update progress
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        30,
        "agoda_booking_data_retrieval",
        undefined
      );
    }

    // Search by booking IDs if reservations are provided
    if (reservations && reservations.length > 0) {
      await dualLogInfo(
        `Processing ${reservations.length} reservation group(s) with booking IDs`
      );

      // Extract all booking IDs from reservations array
      const allBookingIds: string[] = [];
      reservations.forEach((reservation) => {
        if (reservation.idList && Array.isArray(reservation.idList)) {
          allBookingIds.push(...reservation.idList);
        }
      });

      await dualLogInfo(
        `Found ${allBookingIds.length} booking IDs to search: ${allBookingIds
          .slice(0, 5)
          .join(", ")}${allBookingIds.length > 5 ? "..." : ""}`
      );

      // Process each booking ID: search, click row, navigate to payout tab
      if (allBookingIds.length > 0) {
        await dualLogInfo("Processing booking IDs...");

        // Wait for the booking list/table to be visible
        await delay(3000);

        // Process each booking ID
        for (const bookingId of allBookingIds) {
          try {
            await dualLogInfo(`Processing booking ID: ${bookingId}`);

            // Use the dedicated function to search and navigate to payout tab
            const success = await searchBookingAndNavigateToPayout(
              newPage,
              bookingId,
              agodaUsername
            );

            if (success) {
              await dualLogInfo(
                `✅ Successfully processed booking ID: ${bookingId}`
              );
              // Add delay between processing different bookings
              await delay(2000);
            } else {
              await dualLogError(
                `❌ Failed to process booking ID: ${bookingId}`
              );
              // Continue with next booking ID even if this one failed
            }
          } catch (searchError: any) {
            await dualLogError(
              `Error processing booking ID ${bookingId}:`,
              searchError.message
            );
            // Continue with next booking ID
          }
        }
      }
    } else {
      await dualLogInfo(
        "No reservations provided - will process all bookings in date range"
      );
    }

    return [];
  } catch (error: any) {
    await dualLogError("Error in getAgodaRetrivealData:", error);
    throw error;
  }
}
