import { Page } from "puppeteer";
import {
  getRetrievalJobId,
  isOtpReleasedForRetrieval,
  markOtpReleasedForRetrieval,
} from "../../agoda-retriveal.js";
import { delay } from "../../common/delay.js";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { otpCompletionNotifier } from "../../common/otp-completion-notifier.js";
import { otpStatusManager } from "../../common/otp-status-manager.js";
import { retrievalService } from "../../services/retriveal-job.service.js";
import { getYcsRetrievalOtpCode } from "../utils/retriveal-email.js";
import {
  BOOKING_DETAIL,
  BOOKING_RESULTS,
  BOOKING_SEARCH,
  OTP_CHECK_SELECTORS,
  OTP_VERIFICATION,
  UPC_WIDGET,
} from "../utils/selectors.js";

/**
 * Searches for a booking ID and navigates to the Get payout (UPC) tab
 * @param page - Puppeteer page instance
 * @param bookingId - The booking ID to search for
 * @param userEmail - The user's email address (agodausername) for OTP verification
 * @param retrievalId - Optional retrieval ID for saving card info to database
 * @returns Promise<boolean> - Returns true if successful, false otherwise
 */
export async function searchBookingAndNavigateToPayout(
  page: Page,
  bookingId: string,
  userEmail?: string,
  retrievalId?: string
): Promise<boolean> {
  const jobId = getRetrievalJobId();
  try {
    await dualLogInfo(`Starting search for booking ID: ${bookingId}`, {
      jobId,
      bookingId,
    });

    // Step 1: Find and fill the booking ID input field
    await dualLogInfo("Looking for booking ID / Guest name input field...", {
      jobId,
      bookingId,
    });

    // Wait for the search input field to be available
    try {
      await page.waitForSelector(BOOKING_SEARCH.INPUT, {
        visible: true,
        timeout: 10000,
      });
    } catch (error) {
      await dualLogError(
        `Search input field not found: ${BOOKING_SEARCH.INPUT}`,
        error
      );
      return false;
    }

    // Clear existing value and type the booking ID
    await dualLogInfo(`Entering booking ID: ${bookingId} in search field`, {
      jobId,
      bookingId,
    });

    // Click on the input field first
    await page.click(BOOKING_SEARCH.INPUT);
    await delay(300);

    // Use $eval to directly manipulate the input element (most reliable)
    await page.$eval(BOOKING_SEARCH.INPUT, (input: HTMLInputElement) => {
      input.focus();
      input.select();
      input.value = "";
      // Trigger all necessary events
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    });
    await delay(300);

    // Also use keyboard method to ensure it's cleared
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA"); // Select all (Ctrl+A)
    await page.keyboard.up("Control");
    await delay(100);
    await page.keyboard.press("Delete"); // Delete selected text
    await delay(200);
    await page.keyboard.press("Backspace"); // Additional backspace for safety
    await delay(200);

    // Verify the field is actually empty before typing
    const currentValue = await page.$eval(
      BOOKING_SEARCH.INPUT,
      (input: HTMLInputElement) => input.value
    );

    if (currentValue && currentValue.length > 0) {
      await dualLogInfo(
        `Input field still has value: "${currentValue}", force clearing...`,
        { jobId, bookingId }
      );
      // Force clear using $eval
      await page.$eval(BOOKING_SEARCH.INPUT, (input: HTMLInputElement) => {
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await delay(300);
    } else {
      await dualLogInfo("Input field cleared successfully", {
        jobId,
        bookingId,
      });
    }

    // Now type the new booking ID
    await page.type(BOOKING_SEARCH.INPUT, bookingId, { delay: 100 });
    await delay(1000);

    // Step 2: Click the Search button
    await dualLogInfo("Clicking Search button...", { jobId, bookingId });

    try {
      await page.waitForSelector(BOOKING_SEARCH.BUTTON, {
        visible: true,
        timeout: 5000,
      });
      await page.click(BOOKING_SEARCH.BUTTON);
      await dualLogInfo("Search button clicked", { jobId, bookingId });
    } catch (error) {
      await dualLogError("Search button not found or not clickable", error, {
        jobId,
        bookingId,
      });
      return false;
    }

    // Step 3: Wait for search results to load
    await dualLogInfo("Waiting for search results to load...", {
      jobId,
      bookingId,
    });
    await delay(3000); // Initial wait

    // Wait for the booking result row to appear
    const bookingRowSelector = BOOKING_RESULTS.ROW(bookingId);

    try {
      await page.waitForSelector(bookingRowSelector, {
        visible: true,
        timeout: 15000,
      });
      await dualLogInfo(`Booking row found for ID: ${bookingId}`, {
        jobId,
        bookingId,
      });
    } catch (error) {
      await dualLogError(`Booking row not found for ID: ${bookingId}`, error, {
        jobId,
        bookingId,
      });
      return false;
    }

    // Step 4: Click on the booking row (preferably on the guest name)
    await dualLogInfo("Clicking on booking row (guest name)...", {
      jobId,
      bookingId,
    });

    // Try to click on the guest name first, fallback to the row
    const guestNameSelector = BOOKING_RESULTS.GUEST_NAME(bookingId);

    try {
      const guestNameElement = await page.$(guestNameSelector);
      if (guestNameElement) {
        await guestNameElement.click();
        await dualLogInfo("Clicked on guest name", { jobId, bookingId });
      } else {
        // Fallback to clicking the row itself
        await page.click(bookingRowSelector);
        await dualLogInfo("Clicked on booking row", { jobId, bookingId });
      }
    } catch (error) {
      await dualLogError("Failed to click on booking row", error, {
        jobId,
        bookingId,
      });
      return false;
    }

    // Step 5: Wait for the right sidebar to appear
    await dualLogInfo("Waiting for booking detail sidebar to appear...", {
      jobId,
      bookingId,
    });
    await delay(2000);

    // Wait for the tab list to be visible (indicates sidebar is open)
    try {
      await page.waitForSelector(BOOKING_DETAIL.TAB_LIST, {
        visible: true,
        timeout: 10000,
      });
      await dualLogInfo("Booking detail sidebar appeared", {
        jobId,
        bookingId,
      });
    } catch (error) {
      await dualLogError("Booking detail sidebar did not appear", error, {
        jobId,
        bookingId,
      });
      return false;
    }

    // Step 6: Click on "Get payout (UPC)" tab
    await dualLogInfo("Clicking on 'Get payout (UPC)' tab...", {
      jobId,
      bookingId,
    });

    try {
      await page.waitForSelector(BOOKING_DETAIL.PAYOUT_TAB, {
        visible: true,
        timeout: 5000,
      });
      await page.click(BOOKING_DETAIL.PAYOUT_TAB);
      await dualLogInfo("Successfully clicked on 'Get payout (UPC)' tab", {
        jobId,
        bookingId,
      });
      await delay(2000);
    } catch (error) {
      await dualLogError("Failed to click on 'Get payout (UPC)' tab", error, {
        jobId,
        bookingId,
      });
      return false;
    }

    // Step 7: Check if OTP verification is required (iframe with login form)
    await dualLogInfo("Checking if OTP verification is required...", {
      jobId,
      bookingId,
    });

    try {
      // Wait for iframe to appear (if it redirects to login) or OTP form to appear on main page
      await delay(3000);

      // Also wait a bit more for OTP form to potentially appear
      // Sometimes the OTP form appears after clicking the payout tab
      await delay(2000);

      // First, check if the universal login iframe exists on the main page
      const hasUniversalLoginIframe = await page.evaluate(() => {
        const ulFrame = document.querySelector(
          'iframe[data-cy="ul-app-frame"]'
        );
        return !!ulFrame;
      });

      if (hasUniversalLoginIframe) {
        await dualLogInfo(
          "✅ Universal Login iframe detected (data-cy='ul-app-frame')",
          { jobId, bookingId }
        );
      }

      // Check if there's an iframe with the login/OTP form
      const iframes = await page.frames();
      let otpFrame = null;

      await dualLogInfo(`Found ${iframes.length} frames on the page`, {
        jobId,
        bookingId,
      });

      for (const frame of iframes) {
        try {
          // Get frame URL for debugging
          const frameUrl = frame.url();
          await dualLogInfo(`Checking frame: ${frameUrl}`, {
            jobId,
            bookingId,
          });

          // Check if this frame contains the OTP verification form
          const hasOtpForm = await frame.evaluate((selectors) => {
            // Check for old OTP verification method selection
            const otpOptionEmail = document.querySelector(
              selectors.EMAIL_OPTION
            );
            // Check for old OTP input form
            const otpInputs = document.querySelector(selectors.FIRST_INPUT);

            // Check for new unified auth OTP form
            const verifyOtpPanel = document.querySelector(
              selectors.VERIFY_OTP_PANEL
            );
            const verifyOtpForm = document.querySelector(
              selectors.VERIFY_OTP_FORM
            );

            // Also check for "OTP has been sent to" text which indicates OTP form is present
            const otpSentText = Array.from(document.querySelectorAll("*")).some(
              (el) => el.textContent?.includes("OTP has been sent to")
            );

            // Check for "Please verify your identity" which indicates verification method selection
            const verifyIdentityText = Array.from(
              document.querySelectorAll("*")
            ).some((el) => el.textContent?.includes("Please verify your identity"));

            return {
              hasOtpOptionEmail: !!otpOptionEmail,
              hasOtpInputs: !!otpInputs,
              hasVerifyOtpPanel: !!verifyOtpPanel,
              hasVerifyOtpForm: !!verifyOtpForm,
              hasOtpSentText: otpSentText,
              hasVerifyIdentityText: verifyIdentityText,
              hasAnyOtpElements:
                !!otpOptionEmail ||
                !!otpInputs ||
                !!verifyOtpPanel ||
                !!verifyOtpForm ||
                otpSentText ||
                verifyIdentityText,
            };
          }, OTP_CHECK_SELECTORS);

          await dualLogInfo(`Frame OTP check result:`, {
            jobId,
            bookingId,
            frameUrl,
            hasOtpForm,
          });

          if (hasOtpForm.hasAnyOtpElements) {
            otpFrame = frame;
            await dualLogInfo("✅ Found OTP verification iframe", {
              jobId,
              bookingId,
              frameUrl,
              hasOtpForm,
            });
            break;
          }
        } catch (frameError) {
          // Frame might not be accessible, continue checking other frames
          await dualLogInfo(`Frame check error (continuing): ${frameError}`, {
            jobId,
            bookingId,
          });
          continue;
        }
      }

      // If no iframe found, check the main page
      if (!otpFrame) {
        await dualLogInfo("No OTP iframe found, checking main page...", {
          jobId,
          bookingId,
        });

        // Wait a bit more and check again - OTP form might appear with a delay
        await delay(2000);

        const hasOtpOnMainPage = await page.evaluate((selectors) => {
          // Check for old OTP form selectors
          const otpOptionEmail = document.querySelector(selectors.EMAIL_OPTION);
          const otpInputs = document.querySelector(selectors.FIRST_INPUT);

          // Check for new unified auth OTP form
          const verifyOtpPanel = document.querySelector(
            selectors.VERIFY_OTP_PANEL
          );
          const verifyOtpForm = document.querySelector(
            selectors.VERIFY_OTP_FORM
          );

          // Also check for "OTP has been sent to" text which indicates OTP form is present
          const otpSentText = Array.from(document.querySelectorAll("*")).some(
            (el) => el.textContent?.includes("OTP has been sent to")
          );

          // Log what we found for debugging
          const found = !!(
            otpOptionEmail ||
            otpInputs ||
            verifyOtpPanel ||
            verifyOtpForm ||
            otpSentText
          );
          if (found) {
            console.log("OTP form detected on main page:", {
              otpOptionEmail: !!otpOptionEmail,
              otpInputs: !!otpInputs,
              verifyOtpPanel: !!verifyOtpPanel,
              verifyOtpForm: !!verifyOtpForm,
              otpSentText: otpSentText,
            });
          }

          return found;
        }, OTP_CHECK_SELECTORS);

        if (hasOtpOnMainPage) {
          await dualLogInfo("OTP form found on main page", {
            jobId,
            bookingId,
          });
          // Use main page for OTP handling
          const otpHandled = await handleOtpVerification(
            page,
            null,
            bookingId,
            userEmail
          );
          if (!otpHandled) {
            return false;
          }

          // After OTP verification, we need to search again and navigate to payout tab
          await dualLogInfo(
            "OTP verification completed, re-searching for booking ID to access payout tab...",
            { jobId, bookingId }
          );
          await delay(3000); // Wait for page to settle after OTP submission

          // Re-search for the same booking ID
          const reSearchSuccess = await reSearchAndNavigateToPayout(
            page,
            bookingId
          );
          if (!reSearchSuccess) {
            await dualLogError(
              "Failed to re-search and navigate to payout tab after OTP verification",
              undefined,
              { jobId, bookingId }
            );
            return false;
          }
        } else {
          await dualLogInfo(
            "No OTP verification required - proceeding to scrape UPC widget data",
            { jobId, bookingId }
          );

          // Release OTP immediately since no payout OTP verification is needed
          // This allows other jobs to start sooner
          // IMPORTANT: Verify OTP is still owned by this job before releasing to avoid race conditions
          const retrievalJobId = getRetrievalJobId();
          if (retrievalJobId && !isOtpReleasedForRetrieval()) {
            // Check if OTP is still owned by this job before attempting release
            const isOwnedByThisJob = await otpStatusManager.isOtpOwnedByJob(
              retrievalJobId
            );

            if (isOwnedByThisJob) {
              await dualLogInfo(
                "No payout OTP needed - verifying OTP ownership before release",
                { jobId, bookingId }
              );
              if (markOtpReleasedForRetrieval()) {
                // Directly release OTP in the database
                const released = await otpStatusManager.releaseOtp(
                  retrievalJobId
                );
                if (released) {
                  await dualLogInfo(
                    "✅ OTP released (no payout OTP verification needed)",
                    { jobId, bookingId }
                  );
                } else {
                  await dualLogError(
                    "⚠️ Failed to release OTP (no payout OTP needed)",
                    new Error("OTP release returned false"),
                    { jobId, bookingId }
                  );
                }

                // Also notify the worker pool (for queue processing)
                otpCompletionNotifier.notifyOtpCompleted(retrievalJobId);
              }
            } else {
              await dualLogInfo(
                "No payout OTP needed - OTP not owned by this job (job_id mismatch). OTP may have been released by another job.",
                { jobId, bookingId }
              );
            }
          } else if (retrievalJobId && isOtpReleasedForRetrieval()) {
            await dualLogInfo(
              "No payout OTP needed - OTP already released earlier",
              { jobId, bookingId }
            );
          }
        }
      } else {
        // Handle OTP in iframe
        const otpHandled = await handleOtpVerification(
          page,
          otpFrame,
          bookingId,
          userEmail
        );
        if (!otpHandled) {
          return false;
        }

        // After OTP verification, we need to search again and navigate to payout tab
        await dualLogInfo(
          "OTP verification completed, re-searching for booking ID to access payout tab...",
          { jobId, bookingId }
        );
        await delay(3000); // Wait for page to settle after OTP submission

        // Re-search for the same booking ID
        const reSearchSuccess = await reSearchAndNavigateToPayout(
          page,
          bookingId
        );
        if (!reSearchSuccess) {
          await dualLogError(
            "Failed to re-search and navigate to payout tab after OTP verification",
            undefined,
            { jobId, bookingId }
          );
          return false;
        }
      }

      // Step 8: If no OTP verification was needed, or after OTP is completed, scrape UPC widget data
      await dualLogInfo("Checking for UPC widget data...", {
        jobId,
        bookingId,
      });
      await delay(2000); // Wait for page/widget to load

      const upcData = await scrapeUpcWidgetData(page, bookingId);
      if (upcData) {
        await dualLogInfo("✅ UPC widget data scraped successfully", {
          jobId,
          bookingId,
        });
        console.log("=== UPC Widget Data ===");
        console.log("Card Holder Name:", upcData.cardHolderName);
        console.log("Card Number:", upcData.cardNumber);
        console.log("Expiration Date:", upcData.expirationDate);
        console.log("CVC Code:", upcData.cvcCode);
        console.log("======================");

        // Save card info to database if retrievalId is provided
        if (retrievalId && upcData.cardNumber && upcData.expirationDate) {
          try {
            // Format expiration date from "2026/01" to "01/26" or keep as is
            let formattedExpiryDate = upcData.expirationDate;
            if (formattedExpiryDate.includes("/")) {
              // Format: "2026/01" -> "01/26"
              const [year, month] = formattedExpiryDate.split("/");
              if (year && month) {
                const shortYear = year.length === 4 ? year.slice(-2) : year;
                formattedExpiryDate = `${month}/${shortYear}`;
              }
            }

            const cardInfo = {
              card_number: upcData.cardNumber || "",
              expiry_date: formattedExpiryDate,
              cvv: upcData.cvcCode || undefined,
              reason_for_charge: upcData.cardHolderName || undefined,
            };

            const updatedItem =
              await retrievalService.updateRetrievalItemCardInfo(
                retrievalId,
                bookingId,
                cardInfo
              );

            if (updatedItem) {
              await dualLogInfo(
                `✅ Card info saved to database for booking ID: ${bookingId}`,
                { jobId, bookingId }
              );
            } else {
              await dualLogError(
                `Failed to save card info to database for booking ID: ${bookingId}. Item may not exist yet.`,
                undefined,
                { jobId, bookingId }
              );
            }
          } catch (dbError: any) {
            await dualLogError(
              `Error saving card info to database for booking ID ${bookingId}:`,
              dbError,
              { jobId, bookingId }
            );
          }
        }
      } else {
        await dualLogInfo("UPC widget data not found or not accessible", {
          jobId,
          bookingId,
        });
      }
    } catch (error) {
      await dualLogError("Error checking for OTP verification", error, {
        jobId,
        bookingId,
      });
      // Continue anyway - OTP might not be required

      // Try to scrape UPC data even if OTP check failed
      try {
        await delay(2000);
        const upcData = await scrapeUpcWidgetData(page, bookingId);
        if (upcData) {
          await dualLogInfo(
            "✅ UPC widget data scraped successfully (after error)"
          );
          console.log("=== UPC Widget Data ===");
          console.log("Card Holder Name:", upcData.cardHolderName);
          console.log("Card Number:", upcData.cardNumber);
          console.log("Expiration Date:", upcData.expirationDate);
          console.log("CVC Code:", upcData.cvcCode);
          console.log("======================");

          // Save card info to database if retrievalId is provided
          if (retrievalId && upcData.cardNumber && upcData.expirationDate) {
            try {
              // Format expiration date from "2026/01" to "01/26" or keep as is
              let formattedExpiryDate = upcData.expirationDate;
              if (formattedExpiryDate.includes("/")) {
                // Format: "2026/01" -> "01/26"
                const [year, month] = formattedExpiryDate.split("/");
                if (year && month) {
                  const shortYear = year.length === 4 ? year.slice(-2) : year;
                  formattedExpiryDate = `${month}/${shortYear}`;
                }
              }

              const cardInfo = {
                card_number: upcData.cardNumber || "",
                expiry_date: formattedExpiryDate,
                cvv: upcData.cvcCode || undefined,
                reason_for_charge: upcData.cardHolderName || undefined,
              };

              const updatedItem =
                await retrievalService.updateRetrievalItemCardInfo(
                  retrievalId,
                  bookingId,
                  cardInfo
                );

              if (updatedItem) {
                await dualLogInfo(
                  `✅ Card info saved to database for booking ID: ${bookingId}`,
                  { jobId, bookingId }
                );
              } else {
                await dualLogError(
                  `Failed to save card info to database for booking ID: ${bookingId}. Item may not exist yet.`,
                  undefined,
                  { jobId, bookingId }
                );
              }
            } catch (dbError: any) {
              await dualLogError(
                `Error saving card info to database for booking ID ${bookingId}:`,
                dbError,
                { jobId, bookingId }
              );
            }
          }
        }
      } catch (scrapeError) {
        await dualLogError("Error scraping UPC widget data", scrapeError, {
          jobId,
          bookingId,
        });
      }
    }

    await dualLogInfo(
      `✅ Successfully navigated to Get payout (UPC) tab for booking ID: ${bookingId}`,
      { jobId, bookingId }
    );
    return true;
  } catch (error: any) {
    await dualLogError(
      `Error in searchBookingAndNavigateToPayout for booking ID ${bookingId}:`,
      error,
      { jobId, bookingId }
    );
    return false;
  }
}

/**
 * Handles OTP verification flow after clicking "Get payout (UPC)"
 * @param page - Puppeteer page instance
 * @param frame - Puppeteer frame instance (if OTP is in iframe, null if on main page)
 * @param bookingId - The booking ID for logging purposes
 * @param userEmail - The user's email address (agodausername) for OTP verification
 * @returns Promise<boolean> - Returns true if successful, false otherwise
 */
async function handleOtpVerification(
  page: Page,
  frame: any,
  bookingId: string,
  userEmail?: string
): Promise<boolean> {
  const jobId = getRetrievalJobId();
  const targetPage = frame || page;
  const selectorTimeout = 30000;
  const isIframe = !!frame;

  try {
    await dualLogInfo(
      `🔐 Processing OTP verification for Get payout (UPC)... ${
        isIframe ? "(inside iframe)" : "(on main page)"
      }`,
      { jobId, bookingId, isIframe, frameUrl: frame?.url() || "N/A" }
    );

    // Step 1: Check if we need to select verification method (via Email)
    await dualLogInfo(
      `Checking for OTP verification method selection... ${
        isIframe ? "(inside iframe)" : "(on main page)"
      }`,
      {
        jobId,
        bookingId,
      }
    );

    // Debug: Check what elements are present in the iframe/page
    try {
      const pageElements = await targetPage.evaluate(() => {
        return {
          hasVerifyOtpPanel: !!document.querySelector(
            '[data-cy="verify-otp-panel"]'
          ),
          hasEmailOption: !!document.querySelector(
            '[data-cy="otp-option-email"]'
          ),
          hasSmsOption: !!document.querySelector('[data-cy="otp-option-phone"]'),
          hasOtpInputs: !!document.querySelector('[data-cy="otp-0"]'),
          hasVerifyIdentity: Array.from(document.querySelectorAll("*")).some(
            (el) => el.textContent?.includes("Please verify your identity")
          ),
          hasViaEmail: Array.from(document.querySelectorAll("*")).some((el) =>
            el.textContent?.includes("via Email")
          ),
          bodyTextPreview: document.body.textContent?.substring(0, 200) || "",
        };
      });

      await dualLogInfo(`Elements present in ${isIframe ? "iframe" : "page"}:`, {
        jobId,
        bookingId,
        pageElements,
      });
    } catch (debugError) {
      await dualLogError("Debug check failed:", debugError, {
        jobId,
        bookingId,
      });
    }

    // Try multiple selectors and click methods for the email option
    const emailOptionSelectors = [
      '[data-cy="otp-option-email"]',
      '[data-cy="email-option"]',
      'div[data-cy="otp-option-email"]',
      'button:has-text("via Email")',
      'span:has-text("via Email")',
    ];

    let emailOptionClicked = false;

    for (const selector of emailOptionSelectors) {
      try {
        await targetPage.waitForSelector(selector, {
          visible: true,
          timeout: 5000,
        });

        await dualLogInfo(
          `Found OTP verification method selection with selector: ${selector}, clicking 'via Email'...`,
          { jobId, bookingId }
        );

        // Try multiple click methods for better reliability
        try {
          // Method 1: Regular Puppeteer click
          await targetPage.click(selector);
          await dualLogInfo("Email option clicked using regular click", {
            jobId,
            bookingId,
          });
          emailOptionClicked = true;
        } catch (clickError) {
          await dualLogInfo(
            "Regular click failed, trying JavaScript click...",
            { jobId, bookingId }
          );

          // Method 2: JavaScript click with comprehensive event simulation
          await targetPage.evaluate((sel: string) => {
            const element = document.querySelector(sel) as HTMLElement;
            if (element) {
              // Try direct click
              element.click();

              // Also try clicking on parent elements (sometimes the whole div needs to be clicked)
              const parent = element.parentElement;
              if (parent) {
                parent.click();
              }

              // Dispatch comprehensive mouse events
              const events = [
                new MouseEvent("mouseover", { bubbles: true, cancelable: true }),
                new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
                new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
                new MouseEvent("click", { bubbles: true, cancelable: true }),
              ];

              events.forEach((event) => {
                element.dispatchEvent(event);
                if (parent) {
                  parent.dispatchEvent(event);
                }
              });
            }
          }, selector);

          await dualLogInfo("Email option clicked using JavaScript click", {
            jobId,
            bookingId,
          });
          emailOptionClicked = true;
        }

        await delay(3000); // Wait longer for OTP form to appear after selection
        break; // Exit loop if successful
      } catch (error) {
        // Continue to next selector
        continue;
      }
    }

    if (!emailOptionClicked) {
      await dualLogInfo(
        "No verification method selection found, OTP form may already be visible",
        { jobId, bookingId }
      );
    }

    // Step 2: Wait for OTP input fields to be visible
    await dualLogInfo("Waiting for OTP input fields...", { jobId, bookingId });

    // If email option was clicked, give extra time for the form to appear
    if (emailOptionClicked) {
      await dualLogInfo(
        "Email option was clicked, waiting for OTP form to appear...",
        { jobId, bookingId }
      );
      await delay(2000);
    }

    try {
      await targetPage.waitForSelector(OTP_VERIFICATION.FIRST_INPUT, {
        visible: true,
        timeout: selectorTimeout,
      });
      await dualLogInfo("✅ OTP input fields found", { jobId, bookingId });
    } catch (error) {
      await dualLogError(
        "OTP input fields not found after waiting. Checking page state...",
        error,
        { jobId, bookingId }
      );

      // Debug: Check what's on the page
      const pageDebug = await targetPage.evaluate(() => {
        return {
          hasVerifyOtpPanel: !!document.querySelector(
            '[data-cy="verify-otp-panel"]'
          ),
          hasEmailOption: !!document.querySelector(
            '[data-cy="otp-option-email"]'
          ),
          hasSmsOption: !!document.querySelector('[data-cy="otp-option-phone"]'),
          hasOtpInputs: !!document.querySelector('[data-cy="otp-0"]'),
          bodyText: document.body.textContent?.substring(0, 500) || "",
        };
      });

      await dualLogInfo("Page state debug info:", {
        jobId,
        bookingId,
        pageDebug,
      });

      // If the verification panel is still visible but inputs are not, something went wrong
      if (pageDebug.hasVerifyOtpPanel && !pageDebug.hasOtpInputs) {
        await dualLogError(
          "Verification panel exists but OTP inputs not found. The email option may not have been clicked properly.",
          undefined,
          { jobId, bookingId }
        );
        return false;
      }

      await dualLogInfo(
        "OTP input fields not found, OTP verification may not be required",
        { jobId, bookingId }
      );
      return true; // Not an error - OTP might not be needed
    }

    // Extract reference code and email address from the page
    await dualLogInfo(
      "Extracting reference code and email address from payout OTP page...",
      {
        jobId,
        bookingId,
      }
    );
    let referenceCode: string | null = null;
    let recipientEmail: string | null = userEmail || null;

    try {
      // Extract reference code from [data-cy="otp-refcode"]
      try {
        await targetPage.waitForSelector('[data-cy="otp-refcode"]', {
          timeout: selectorTimeout,
        });

        referenceCode = await targetPage.evaluate(() => {
          const refElement = document.querySelector('[data-cy="otp-refcode"]');
          if (refElement) {
            const text = refElement.textContent?.trim() || "";
            // Extract the code part (e.g., "Refcode: NVQLhK" -> "NVQLhK")
            const match = text.match(/Refcode:\s*([A-Za-z0-9]+)/i);
            return match ? match[1] : text.replace(/^Refcode:\s*/i, "").trim();
          }
          return null;
        });

        if (referenceCode) {
          await dualLogInfo(`✅ Reference code extracted: ${referenceCode}`, {
            jobId,
            bookingId,
          });
        } else {
          await dualLogInfo("⚠️ Could not extract reference code from page", {
            jobId,
            bookingId,
          });
        }
      } catch (refError) {
        await dualLogError(
          "Error extracting reference code (will search without it):",
          refError,
          { jobId, bookingId }
        );
      }

      // Extract email address from "OTP has been sent to {email}"
      try {
        const emailText = await targetPage.evaluate(() => {
          // Look for the specific span element that contains "OTP has been sent to"
          // The email is in a span with class "sc-iGgWBj ecoUic" that contains just this text
          // According to the HTML: <span class="sc-iGgWBj ecoUic">OTP has been sent to chartwell@epchotels.com</span>
          const spans = Array.from(
            document.querySelectorAll("span.sc-iGgWBj.ecoUic")
          );
          for (const span of spans) {
            const text = span.textContent?.trim() || "";
            // Check if this span contains "OTP has been sent to" and is short (just the email line)
            if (text.includes("OTP has been sent to") && text.length < 100) {
              // Verify it doesn't contain other text like "OTP will expire" or "Refcode"
              if (
                !text.includes("OTP will expire") &&
                !text.includes("Refcode") &&
                !text.includes("Submit")
              ) {
                return text;
              }
            }
          }

          // Fallback: look for any element containing "OTP has been sent to" but exclude parent elements
          const allElements = Array.from(document.querySelectorAll("*"));
          for (const element of allElements) {
            const text = element.textContent?.trim() || "";
            if (text.includes("OTP has been sent to")) {
              // Prefer elements that contain only the email sentence (shorter text, no other OTP-related text)
              if (
                text.length < 100 &&
                !text.includes("OTP will expire") &&
                !text.includes("Refcode") &&
                !text.includes("Submit OTP") &&
                !text.includes("Resend")
              ) {
                return text;
              }
            }
          }
          return null;
        });

        if (emailText) {
          // Log the full text for debugging
          await dualLogInfo(`📄 Full email text extracted: ${emailText}`, {
            jobId,
            bookingId,
          });

          // More strict regex to match email address and stop at word boundary
          // This prevents matching "OTP" or other text after the email
          // Pattern: "OTP has been sent to " followed by email
          // The email must end with TLD (2+ letters) followed by whitespace, end of string, or non-alphanumeric
          // This ensures we don't match "comOTP" - we stop at "com"
          const emailMatch = emailText.match(
            /OTP has been sent to\s+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?=\s|$|[^a-zA-Z0-9])/i
          );
          if (emailMatch && emailMatch[1]) {
            recipientEmail = emailMatch[1].trim();

            // Additional validation: check if email ends with valid TLD (not followed by letters)
            // If the extracted email has letters after the TLD (like "comOTP"), trim them
            if (recipientEmail) {
              const emailParts = recipientEmail.split("@");
              if (emailParts.length === 2) {
                const domain = emailParts[1];
                // Find the last dot and extract what should be the TLD
                const lastDotIndex = domain.lastIndexOf(".");
                if (lastDotIndex !== -1) {
                  const afterDot = domain.substring(lastDotIndex + 1);
                  // TLD should be 2-4 letters. If there are more letters after a valid TLD, trim them
                  // Match TLD pattern: 2-4 letters, then check if there are more letters after
                  const tldMatch = afterDot.match(
                    /^([a-zA-Z]{2,4})([a-zA-Z]+)?$/
                  );
                  if (tldMatch && tldMatch[2]) {
                    // There are extra letters after the TLD (like "comOTP" -> TLD is "com", extra is "OTP")
                    const validTld = tldMatch[1];
                    const correctedDomain =
                      domain.substring(0, lastDotIndex + 1) + validTld;
                    recipientEmail = emailParts[0] + "@" + correctedDomain;
                    await dualLogInfo(
                      `🔧 Trimmed invalid text after TLD (${afterDot} -> ${validTld}), corrected email: ${recipientEmail}`,
                      { jobId, bookingId }
                    );
                  }
                }
              }
            }

            // Validate it's a proper email (doesn't contain "OTP" or other invalid characters)
            if (
              recipientEmail &&
              !recipientEmail.toLowerCase().includes("otp") &&
              recipientEmail.includes("@")
            ) {
              await dualLogInfo(
                `✅ Recipient email extracted: ${recipientEmail}`,
                {
                  jobId,
                  bookingId,
                }
              );
            } else {
              await dualLogError(
                `⚠️ Extracted email appears invalid (contains 'OTP' or invalid format): ${recipientEmail}`,
                undefined,
                { jobId, bookingId }
              );
              // Fall back to userEmail
              recipientEmail = userEmail || null;
              await dualLogInfo(
                `Using provided userEmail instead: ${recipientEmail}`,
                { jobId, bookingId }
              );
            }
          } else {
            await dualLogInfo(
              `⚠️ Could not extract email from text: ${emailText.substring(
                0,
                150
              )}`,
              { jobId, bookingId }
            );
            // Fall back to userEmail
            recipientEmail = userEmail || null;
            await dualLogInfo(
              `Using provided userEmail instead: ${recipientEmail}`,
              { jobId, bookingId }
            );
          }
        } else {
          await dualLogInfo(
            "Could not find 'OTP has been sent to' text on page, using provided userEmail",
            { jobId, bookingId }
          );
          recipientEmail = userEmail || null;
        }
      } catch (emailError) {
        await dualLogError(
          "Error extracting recipient email (will use provided userEmail):",
          emailError,
          { jobId, bookingId }
        );
        recipientEmail = userEmail || null;
      }
    } catch (error) {
      await dualLogError(
        "Error extracting page information (will search without filters):",
        error,
        { jobId, bookingId }
      );
    }

    // Step 3: Wait 60 seconds for OTP email to arrive
    await dualLogInfo("Waiting 60 seconds for OTP email delivery...", {
      jobId,
      bookingId,
    });
    await delay(60000);

    // Step 4: Fetch OTP code from email
    if (!recipientEmail) {
      await dualLogError(
        "User email (agodausername) is required for OTP verification",
        undefined,
        { jobId, bookingId }
      );
      return false;
    }

    await dualLogInfo(
      `Now fetching YCS retrieval OTP code from email for ${recipientEmail}...`,
      { jobId, bookingId }
    );

    let otpResult: any = null;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await dualLogInfo(
        `Attempt ${attempt}/${maxRetries} to fetch YCS retrieval OTP code...`,
        { jobId, bookingId }
      );

      // Fetch the OTP code from email using YCS retrieval email helper
      // Note: Reference code is passed for logging but NOT used for email matching
      // (payout OTP emails don't contain the reference code)
      otpResult = await getYcsRetrievalOtpCode(
        recipientEmail,
        10,
        referenceCode || undefined
      );

      if (otpResult.otpCode) {
        await dualLogInfo(
          `OTP code found on attempt ${attempt}: ${otpResult.otpCode}`,
          { jobId, bookingId }
        );
        break;
      }

      if (attempt < maxRetries) {
        await dualLogInfo(
          `Attempt ${attempt} failed, waiting 10 seconds before retry...`,
          { jobId, bookingId }
        );
        await delay(10000);
      }
    }

    if (!otpResult || !otpResult.emailFound) {
      await dualLogError("Failed to access email for OTP code", undefined, {
        jobId,
        bookingId,
      });
      return false;
    }

    if (!otpResult.otpCode) {
      await dualLogError(
        "OTP code not found in recent emails after all attempts",
        undefined,
        { jobId, bookingId }
      );
      return false;
    }

    // Step 5: Fill OTP code into the input fields
    await dualLogInfo(`Filling OTP code: ${otpResult.otpCode}`, {
      jobId,
      bookingId,
    });

    // Split the 6-digit code into individual digits
    const otpDigits = otpResult.otpCode.split("");

    if (otpDigits.length !== 6) {
      await dualLogError(
        `Invalid OTP code length: ${otpDigits.length}. Expected 6 digits.`
      );
      return false;
    }

    // Fill each OTP input field (using data-cy="otp-0" to data-cy="otp-5")
    for (let i = 0; i < 6; i++) {
      const inputSelector = OTP_VERIFICATION.INPUT(i);
      await dualLogInfo(`Filling OTP box ${i} with digit: ${otpDigits[i]}`, {
        jobId,
        bookingId,
      });

      try {
        // Wait for the input field
        await targetPage.waitForSelector(inputSelector, {
          timeout: selectorTimeout,
        });

        // Focus and clear the field
        await targetPage.focus(inputSelector);
        await targetPage.evaluate((selector: string) => {
          const input = document.querySelector(selector) as HTMLInputElement;
          if (input) {
            input.value = "";
            input.focus();
          }
        }, inputSelector);

        // Type the digit
        await targetPage.type(inputSelector, otpDigits[i], { delay: 150 });
      } catch (inputError) {
        await dualLogError(`Failed to fill OTP box ${i}`, inputError, {
          jobId,
          bookingId,
        });
        return false;
      }
    }

    await dualLogInfo("All OTP digits filled successfully", {
      jobId,
      bookingId,
    });
    await delay(1000);

    // Step 6: Click the Submit OTP button
    await dualLogInfo("Looking for Submit OTP button...", { jobId, bookingId });

    try {
      // Wait for button to be enabled
      await targetPage.waitForFunction(
        (selector: string) => {
          const button = document.querySelector(selector) as HTMLButtonElement;
          return button && !button.disabled;
        },
        { timeout: selectorTimeout },
        OTP_VERIFICATION.SUBMIT_BUTTON
      );

      await targetPage.click(OTP_VERIFICATION.SUBMIT_BUTTON);
      await dualLogInfo("Submit OTP button clicked successfully!", {
        jobId,
        bookingId,
      });
      await delay(3000); // Wait for submission to process
    } catch (error) {
      await dualLogError("Failed to click Submit OTP button", error, {
        jobId,
        bookingId,
      });
      return false;
    }

    await dualLogInfo("✅ OTP verification completed successfully", {
      jobId,
      bookingId,
    });

    // Release OTP immediately after payout verification completes (only once)
    // This frees up OTP for other jobs as soon as payout verification is done
    // IMPORTANT: Verify OTP is still owned by this job before releasing to avoid race conditions
    const retrievalJobId = getRetrievalJobId();
    if (retrievalJobId && markOtpReleasedForRetrieval()) {
      // Check if OTP is still owned by this job before attempting release
      const isOwnedByThisJob = await otpStatusManager.isOtpOwnedByJob(
        retrievalJobId
      );

      if (isOwnedByThisJob) {
        await dualLogInfo(
          "Payout OTP verification completed - verifying OTP ownership before release",
          { jobId, bookingId }
        );

        // Directly release OTP in the database
        const released = await otpStatusManager.releaseOtp(retrievalJobId);
        if (released) {
          await dualLogInfo(
            "✅ OTP released after payout verification (verified ownership)",
            { jobId, bookingId }
          );
        } else {
          await dualLogError(
            "⚠️ Failed to release OTP after payout verification",
            new Error("OTP release returned false"),
            { jobId, bookingId }
          );
        }

        // Also notify the worker pool (for queue processing)
        otpCompletionNotifier.notifyOtpCompleted(retrievalJobId);
      } else {
        await dualLogInfo(
          `Payout OTP verification completed - OTP not owned by this job (job_id mismatch). OTP may have been released by another job.`,
          { jobId, bookingId }
        );
      }
    } else if (retrievalJobId) {
      await dualLogInfo(
        "Payout OTP verification completed - OTP already released earlier",
        { jobId, bookingId }
      );
    }

    return true;
  } catch (error: any) {
    await dualLogError("Error in handleOtpVerification:", error, {
      jobId,
      bookingId,
    });
    return false;
  }
}

/**
 * Re-searches for a booking ID and navigates to the Get payout (UPC) tab
 * This is used after OTP verification to re-access the payout tab
 * @param page - Puppeteer page instance
 * @param bookingId - The booking ID to search for
 * @returns Promise<boolean> - Returns true if successful, false otherwise
 */
async function reSearchAndNavigateToPayout(
  page: Page,
  bookingId: string
): Promise<boolean> {
  const jobId = getRetrievalJobId();
  try {
    await dualLogInfo(
      `Re-searching for booking ID: ${bookingId} after OTP verification`,
      { jobId, bookingId }
    );

    // Step 1: Find and fill the booking ID input field
    await dualLogInfo("Looking for booking ID / Guest name input field...", {
      jobId,
      bookingId,
    });

    try {
      await page.waitForSelector(BOOKING_SEARCH.INPUT, {
        visible: true,
        timeout: 10000,
      });
    } catch (error) {
      await dualLogError(
        `Search input field not found: ${BOOKING_SEARCH.INPUT}`,
        error,
        { jobId, bookingId }
      );
      return false;
    }

    // Clear existing value and type the booking ID
    await dualLogInfo(`Entering booking ID: ${bookingId} in search field`, {
      jobId,
      bookingId,
    });

    // Click on the input field first to focus it
    await page.click(BOOKING_SEARCH.INPUT);
    await delay(300);

    // For React-controlled inputs, use keyboard method first (most reliable)
    // Select all existing text
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA"); // Select all (Ctrl+A)
    await page.keyboard.up("Control");
    await delay(100);

    // Delete the selected text
    await page.keyboard.press("Delete");
    await delay(200);

    // Also try Backspace as backup
    await page.keyboard.press("Backspace");
    await delay(200);

    // Use native value setter to properly update React-controlled input
    await page.$eval(BOOKING_SEARCH.INPUT, (input: HTMLInputElement) => {
      // Get the native input value setter
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;

      if (nativeInputValueSetter) {
        // Use native setter to set empty value (bypasses React's value tracking)
        nativeInputValueSetter.call(input, "");
      } else {
        input.value = "";
      }

      // Trigger React's synthetic events
      const inputEvent = new Event("input", {
        bubbles: true,
        cancelable: true,
      });
      const changeEvent = new Event("change", {
        bubbles: true,
        cancelable: true,
      });

      // Set target property for React compatibility
      Object.defineProperty(inputEvent, "target", {
        value: input,
        enumerable: true,
      });
      Object.defineProperty(changeEvent, "target", {
        value: input,
        enumerable: true,
      });

      input.dispatchEvent(inputEvent);
      input.dispatchEvent(changeEvent);

      // Update React's internal value tracker if it exists
      if ((input as any)._valueTracker) {
        (input as any)._valueTracker.setValue("");
      }
    });
    await delay(300);

    // Verify the field is actually empty before typing
    const currentValue = await page.$eval(
      BOOKING_SEARCH.INPUT,
      (input: HTMLInputElement) => input.value
    );

    if (currentValue && currentValue.length > 0) {
      await dualLogInfo(
        `Input field still has value: "${currentValue}", trying alternative clear method...`
      );

      // Try triple-click and delete as last resort
      await page.click(BOOKING_SEARCH.INPUT, { clickCount: 3 });
      await delay(200);
      await page.keyboard.press("Delete");
      await delay(200);
      await page.keyboard.press("Backspace");
      await delay(200);

      // Final verification
      const finalValue = await page.$eval(
        BOOKING_SEARCH.INPUT,
        (input: HTMLInputElement) => input.value
      );

      if (finalValue && finalValue.length > 0) {
        await dualLogError(
          `Warning: Input field still contains "${finalValue}" after clearing attempts. Proceeding anyway.`
        );
      } else {
        await dualLogInfo(
          "Input field cleared successfully after alternative method"
        );
      }
    } else {
      await dualLogInfo("Input field cleared successfully", {
        jobId,
        bookingId,
      });
    }

    // Now type the new booking ID
    await page.type(BOOKING_SEARCH.INPUT, bookingId, { delay: 100 });
    await delay(1000);

    // Step 2: Click the Search button
    await dualLogInfo("Clicking Search button...", { jobId, bookingId });

    try {
      await page.waitForSelector(BOOKING_SEARCH.BUTTON, {
        visible: true,
        timeout: 5000,
      });
      await page.click(BOOKING_SEARCH.BUTTON);
      await dualLogInfo("Search button clicked", { jobId, bookingId });
    } catch (error) {
      await dualLogError("Search button not found or not clickable", error, {
        jobId,
        bookingId,
      });
      return false;
    }

    // Step 3: Wait for search results to load
    await dualLogInfo("Waiting for search results to load...", {
      jobId,
      bookingId,
    });
    await delay(3000);

    // Wait for the booking result row to appear
    const bookingRowSelector = BOOKING_RESULTS.ROW(bookingId);

    try {
      await page.waitForSelector(bookingRowSelector, {
        visible: true,
        timeout: 15000,
      });
      await dualLogInfo(`Booking row found for ID: ${bookingId}`, {
        jobId,
        bookingId,
      });
    } catch (error) {
      await dualLogError(`Booking row not found for ID: ${bookingId}`, error, {
        jobId,
        bookingId,
      });
      return false;
    }

    // Step 4: Click on the booking row (preferably on the guest name)
    await dualLogInfo("Clicking on booking row (guest name)...", {
      jobId,
      bookingId,
    });

    const guestNameSelector = BOOKING_RESULTS.GUEST_NAME(bookingId);

    try {
      const guestNameElement = await page.$(guestNameSelector);
      if (guestNameElement) {
        await guestNameElement.click();
        await dualLogInfo("Clicked on guest name", { jobId, bookingId });
      } else {
        await page.click(bookingRowSelector);
        await dualLogInfo("Clicked on booking row", { jobId, bookingId });
      }
    } catch (error) {
      await dualLogError("Failed to click on booking row", error, {
        jobId,
        bookingId,
      });
      return false;
    }

    // Step 5: Wait for the right sidebar to appear
    await dualLogInfo("Waiting for booking detail sidebar to appear...", {
      jobId,
      bookingId,
    });
    await delay(2000);

    try {
      await page.waitForSelector(BOOKING_DETAIL.TAB_LIST, {
        visible: true,
        timeout: 10000,
      });
      await dualLogInfo("Booking detail sidebar appeared", {
        jobId,
        bookingId,
      });
    } catch (error) {
      await dualLogError("Booking detail sidebar did not appear", error, {
        jobId,
        bookingId,
      });
      return false;
    }

    // Step 6: Click on "Get payout (UPC)" tab
    await dualLogInfo("Clicking on 'Get payout (UPC)' tab...", {
      jobId,
      bookingId,
    });

    try {
      await page.waitForSelector(BOOKING_DETAIL.PAYOUT_TAB, {
        visible: true,
        timeout: 5000,
      });
      await page.click(BOOKING_DETAIL.PAYOUT_TAB);
      await dualLogInfo("Successfully clicked on 'Get payout (UPC)' tab", {
        jobId,
        bookingId,
      });
      await delay(2000);
    } catch (error) {
      await dualLogError("Failed to click on 'Get payout (UPC)' tab", error, {
        jobId,
        bookingId,
      });
      return false;
    }

    await dualLogInfo(
      `✅ Successfully re-navigated to Get payout (UPC) tab for booking ID: ${bookingId}`
    );
    return true;
  } catch (error: any) {
    await dualLogError(
      `Error in reSearchAndNavigateToPayout for booking ID ${bookingId}:`,
      error
    );
    return false;
  }
}

/**
 * Interface for UPC widget scraped data
 */
interface UpcWidgetData {
  cardHolderName: string | null;
  cardNumber: string | null;
  expirationDate: string | null;
  cvcCode: string | null;
}

/**
 * Scrapes UPC widget data from the Get payout (UPC) tab
 * @param page - Puppeteer page instance
 * @param bookingId - The booking ID for logging purposes
 * @returns Promise<UpcWidgetData | null> - Scraped data or null if not found
 */
async function scrapeUpcWidgetData(
  page: Page,
  bookingId: string
): Promise<UpcWidgetData | null> {
  const jobId = getRetrievalJobId();
  try {
    await dualLogInfo(`Scraping UPC widget data for booking ID: ${bookingId}`, {
      jobId,
      bookingId,
    });

    // Wait for UPC widget to be visible
    try {
      await page.waitForSelector(UPC_WIDGET.CONTAINER, {
        visible: true,
        timeout: 10000,
      });
      await dualLogInfo("UPC widget found", { jobId, bookingId });
    } catch (error) {
      await dualLogInfo(
        "UPC widget not found - may not be available for this booking"
      );
      return null;
    }

    // Scrape the data from the UPC widget
    const upcData = await page.evaluate((selectors) => {
      const data: UpcWidgetData = {
        cardHolderName: null,
        cardNumber: null,
        expirationDate: null,
        cvcCode: null,
      };

      // Extract Card Holder Name
      const cardHolderNameElement = document.querySelector(
        selectors.CARD_HOLDER_NAME
      );
      if (cardHolderNameElement) {
        data.cardHolderName = cardHolderNameElement.textContent?.trim() || null;
      }

      // Extract Card Number
      const cardNumberElement = document.querySelector(selectors.CARD_NUMBER);
      if (cardNumberElement) {
        data.cardNumber = cardNumberElement.textContent?.trim() || null;
      }

      // Extract Expiration Date
      const expirationDateElement = document.querySelector(
        selectors.EXPIRATION_DATE
      );
      if (expirationDateElement) {
        data.expirationDate = expirationDateElement.textContent?.trim() || null;
      }

      // Extract CVC Code
      const cvcCodeElement = document.querySelector(selectors.CVC_CODE);
      if (cvcCodeElement) {
        data.cvcCode = cvcCodeElement.textContent?.trim() || null;
      }

      return data;
    }, UPC_WIDGET);

    await dualLogInfo("UPC widget data extracted successfully", {
      jobId,
      bookingId,
    });
    return upcData;
  } catch (error: any) {
    await dualLogError("Error scraping UPC widget data:", error, {
      jobId,
      bookingId,
    });
    return null;
  }
}
