import { Browser, Page } from "puppeteer";
import {
  getRetrievalJobId,
  isOtpReleasedForRetrieval,
  markOtpReleasedForRetrieval,
} from "../../agoda-retriveal.js";
import { delay } from "../../common/delay.js";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { otpCompletionNotifier } from "../../common/otp-completion-notifier.js";
import { otpStatusManager } from "../../common/otp-status-manager.js";
import { progressManager } from "../../common/progress-manager.js";
import { scrapingStateManager } from "../../common/scraping-state.js";
import {
  takeErrorScreenshot,
  takeSuccessScreenshot,
} from "../../common/screenshot-helper.js";
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
  agodaUsername?: string,
  retrievalId?: string
): Promise<any[]> {
  let newPage: Page | undefined;
  let client: any;

  try {
    // Check if scraping is paused before starting
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogError(
        "Scraping was stopped during booking data retrieval",
        undefined,
        { jobId }
      );
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
    await dualLogInfo(`Navigating to booking data URL: ${bookingUrl}`, {
      jobId,
    });

    await delay(5000);

    // Navigate to the booking data page
    const newPage = await browser.newPage();

    let navigationAttempts = 0;
    const maxNavigationAttempts = 3;
    let reservationsFound = false;

    while (navigationAttempts < maxNavigationAttempts && !reservationsFound) {
      navigationAttempts++;

      await dualLogInfo(
        `Navigation attempt ${navigationAttempts}/${maxNavigationAttempts} to booking data URL: ${bookingUrl}`,
        { jobId }
      );

      try {
        // Progressive timeout increase: 60s, 90s, 120s
        const navigationTimeout = loadingTimeout * (1 + navigationAttempts * 0.5);
        
        await dualLogInfo(
          `Using navigation timeout: ${navigationTimeout}ms (attempt ${navigationAttempts})`,
          { jobId }
        );

        // Try with networkidle2 first (ideal but might timeout on slow tables)
        try {
          await newPage.goto(bookingUrl, {
            waitUntil: "networkidle2",
            timeout: navigationTimeout,
          });
          
          await dualLogInfo("Navigation completed with networkidle2", { jobId });
        } catch (networkIdleError: any) {
          // If networkidle2 times out, try with just domcontentloaded (more lenient)
          if (networkIdleError.message?.includes("Navigation timeout")) {
            await dualLogInfo(
              "networkidle2 timeout, retrying with domcontentloaded...",
              { jobId }
            );
            
            await newPage.goto(bookingUrl, {
              waitUntil: "domcontentloaded",
              timeout: navigationTimeout,
            });
            
            await dualLogInfo("Navigation completed with domcontentloaded", { jobId });
            
            // Give extra time for React/table to load after DOM is ready
            await delay(10000);
          } else {
            throw networkIdleError;
          }
        }

        await newPage.waitForSelector(PAGE_LOADING.BODY, {
          timeout: loadingTimeout,
        });

        // Wait for the page to load completely
        await delay(5000);
      } catch (navigationError: any) {
        await dualLogError(
          `Navigation error on attempt ${navigationAttempts}/${maxNavigationAttempts}:`,
          navigationError,
          { jobId }
        );

        if (navigationAttempts < maxNavigationAttempts) {
          await dualLogInfo(
            `Will retry navigation in 5 seconds... (attempt ${navigationAttempts}/${maxNavigationAttempts})`,
            { jobId }
          );
          await delay(5000);
          continue; // Skip to next iteration
        } else {
          // Last attempt failed
          throw new Error(
            `Failed to navigate to booking page after ${maxNavigationAttempts} attempts. Last error: ${navigationError.message}`
          );
        }
      }

      // Check for "Reservations" text on the page
      try {
        await dualLogInfo("Checking for 'Reservations' text on the page...", {
          jobId,
        });

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
                `Found Reservations element with selector: ${selector}`,
                { jobId }
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
            await dualLogInfo("Found 'Reservations' text in page content", {
              jobId,
            });
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
            "✅ Reservations text found - page loaded successfully!",
            { jobId }
          );
          break;
        } else {
          await dualLogInfo(
            `❌ Reservations text not found on attempt ${navigationAttempts}`,
            { jobId }
          );

          if (navigationAttempts < maxNavigationAttempts) {
            await dualLogInfo(`Retrying navigation in 3 seconds...`, { jobId });
            await delay(3000);
          }
        }
      } catch (checkError: any) {
        await dualLogError(
          `Error checking for Reservations text on attempt ${navigationAttempts}:`,
          checkError.message,
          { jobId }
        );

        if (navigationAttempts < maxNavigationAttempts) {
          await dualLogInfo(`Retrying navigation due to check error...`, {
            jobId,
          });
          await delay(3000);
        }
      }
    }

    // Final validation
    if (!reservationsFound) {
      const errorMessage = `Failed to find 'Reservations' text after ${maxNavigationAttempts} navigation attempts`;
      await dualLogError(errorMessage, undefined, { jobId });
      throw new Error(errorMessage);
    }

    await dualLogInfo(
      "Successfully navigated to booking data page and confirmed Reservations section",
      { jobId }
    );

    // CRITICAL: Verify search input field exists (confirms we're on the actual booking page, not error page)
    await dualLogInfo("Verifying search input field exists...", { jobId });
    
    try {
      const searchInputSelector = 'input[data-element-name="ycs-booking-search-bid-guestname"], input[data-testid="search-box"]';
      
      // Increased timeout for slow-loading tables (30 seconds)
      await newPage.waitForSelector(searchInputSelector, {
        visible: true,
        timeout: 30000,
      });
      
      await dualLogInfo("✅ Search input field found - booking page loaded correctly", { jobId });
      
      // ✨ BROWSER-NATIVE: Wait for page to be fully loaded using browser signals
      await dualLogInfo("Waiting for page to be fully loaded (using browser signals)...", { jobId });
      
      try {
        // Wait for document.readyState to be 'complete' and all resources loaded
        const pageFullyLoaded = await newPage.waitForFunction(
          () => {
            // 1. Check document.readyState is 'complete' (all resources including images, stylesheets loaded)
            if (document.readyState !== 'complete') {
              return false;
            }
            
            // 2. Check if there are any pending fetch/XHR requests using Performance API
            const performanceEntries = performance.getEntriesByType('resource');
            const recentRequests = performanceEntries.filter((entry: any) => {
              // Check for requests that completed very recently (within last 500ms)
              const timeSinceResponse = performance.now() - (entry.responseEnd || 0);
              return timeSinceResponse < 500;
            });
            
            // If there are recent requests, page is still loading data
            if (recentRequests.length > 0) {
              return false;
            }
            
            // 3. Check for active network requests using window.performance
            // @ts-ignore - performance.timing is deprecated but still works
            const navigationTiming = performance.timing;
            const loadComplete = navigationTiming.loadEventEnd > 0;
            
            if (!loadComplete) {
              return false;
            }
            
            // 4. Additional check: No fetch/XHR in progress
            // React apps often show this in window.__REACT_DEVTOOLS_GLOBAL_HOOK__ or similar
            // But we'll use a simpler heuristic: check if images are still loading
            const images = Array.from(document.images);
            const allImagesLoaded = images.every((img: HTMLImageElement) => img.complete);
            
            if (!allImagesLoaded) {
              return false;
            }
            
            // All checks passed - page is fully loaded
            return true;
          },
          { timeout: 30000, polling: 500 }  // Check every 500ms, max 30 seconds
        ).then(() => ({ loaded: true, method: 'browser-signals' }))
        .catch(() => ({ loaded: false, method: 'timeout' }));
        
        if (pageFullyLoaded.loaded) {
          await dualLogInfo("✅ Page fully loaded (confirmed by browser signals)", { jobId });
        } else {
          await dualLogInfo("⏱️ Browser signal timeout - page may still be loading, proceeding anyway", { jobId });
        }
        
        // Get detailed page state from browser
        const pageState = await newPage.evaluate(() => {
          return {
            readyState: document.readyState,
            loadEventFired: performance.timing.loadEventEnd > 0,
            domContentLoaded: performance.timing.domContentLoadedEventEnd > 0,
            allImagesLoaded: Array.from(document.images).every((img: HTMLImageElement) => img.complete),
            totalImages: document.images.length,
            totalStylesheets: document.styleSheets.length,
            totalScripts: document.scripts.length,
          };
        });
        
        await dualLogInfo("Browser-native page state:", {
          jobId,
          ...pageState
        });
        
      } catch (dynamicWaitError) {
        // Dynamic wait failed, but continue anyway
        await dualLogInfo("Dynamic wait check failed, proceeding with processing", {
          jobId,
          error: dynamicWaitError
        });
      }
      
    } catch (searchInputError) {
      const errorMessage = `Page shows 'Reservations' text but search input field is missing. This usually means the property ID (${agodaId}) was not found or the page failed to load correctly.`;
      
      await dualLogError(errorMessage, searchInputError, { jobId, agodaId });
      
      // Take error screenshot
      if (jobId) {
        try {
          await takeErrorScreenshot(newPage, jobId, "booking_page_search_input_missing");
        } catch (screenshotError) {
          await dualLogError("Failed to take error screenshot", screenshotError);
        }
      }
      
      throw new Error(errorMessage);
    }

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
        `Processing ${reservations.length} reservation group(s) with booking IDs`,
        { jobId }
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
          .join(", ")}${allBookingIds.length > 5 ? "..." : ""}`,
        { jobId }
      );

      // Process each booking ID: search, click row, navigate to payout tab
      if (allBookingIds.length > 0) {
        await dualLogInfo("Processing booking IDs...", { jobId });

        // Wait for the booking list/table to be visible
        await delay(3000);

        // Process each booking ID
        for (const bookingId of allBookingIds) {
          try {
            await dualLogInfo(`Processing booking ID: ${bookingId}`, { jobId });

            // Use the dedicated function to search and navigate to payout tab
            const success = await searchBookingAndNavigateToPayout(
              newPage,
              bookingId,
              agodaUsername,
              retrievalId
            );

            if (success) {
              await dualLogInfo(
                `✅ Successfully processed booking ID: ${bookingId}`,
                { jobId }
              );
              // Add delay between processing different bookings
              await delay(2000);
            } else {
              await dualLogError(
                `❌ Failed to process booking ID: ${bookingId}`,
                undefined,
                { jobId }
              );
              // Continue with next booking ID even if this one failed
            }
          } catch (searchError: any) {
            await dualLogError(
              `Error processing booking ID ${bookingId}:`,
              searchError.message,
              { jobId }
            );
            // Continue with next booking ID
          }
        }
      }
    } else {
      await dualLogInfo(
        "No reservations provided - will process all bookings in date range",
        { jobId }
      );
    }

    // Release OTP at the end of retrieval job if it hasn't been released yet
    // This ensures OTP is released even if no bookings were processed or payout verification wasn't needed
    // IMPORTANT: Verify OTP is still owned by this job before releasing to avoid race conditions
    const retrievalJobId = getRetrievalJobId();
    if (retrievalJobId && !isOtpReleasedForRetrieval()) {
      // Check if OTP is still owned by this job before attempting release
      const isOwnedByThisJob = await otpStatusManager.isOtpOwnedByJob(
        retrievalJobId
      );

      if (isOwnedByThisJob) {
        await dualLogInfo(
          "Retrieval job completed - verifying OTP ownership before release",
          { jobId }
        );
        if (markOtpReleasedForRetrieval()) {
          // Directly release OTP in the database
          const released = await otpStatusManager.releaseOtp(retrievalJobId);
          if (released) {
            await dualLogInfo(
              "✅ OTP released at end of retrieval job (verified ownership)",
              { jobId }
            );
          } else {
            await dualLogError(
              "⚠️ Failed to release OTP at end of retrieval job",
              new Error("OTP release returned false"),
              { jobId }
            );
          }

          // Also notify the worker pool (for queue processing)
          otpCompletionNotifier.notifyOtpCompleted(retrievalJobId);
        }
      } else {
        await dualLogInfo(
          `Retrieval job completed - OTP not owned by this job (job_id mismatch). OTP may have been released by another job or never reserved.`,
          { jobId }
        );
      }
    } else if (retrievalJobId && isOtpReleasedForRetrieval()) {
      await dualLogInfo(
        "Retrieval job completed - OTP already released after payout verification",
        { jobId }
      );
    }

    return [];
  } catch (error: any) {
    await dualLogError("Error in getAgodaRetrivealData:", error, { jobId });
    throw error;
  }
}
