import { Page } from "puppeteer";
import { delay } from "../../common/delay.js";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
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
 * @returns Promise<boolean> - Returns true if successful, false otherwise
 */
export async function searchBookingAndNavigateToPayout(
  page: Page,
  bookingId: string,
  userEmail?: string
): Promise<boolean> {
  try {
    await dualLogInfo(`Starting search for booking ID: ${bookingId}`);

    // Step 1: Find and fill the booking ID input field
    await dualLogInfo("Looking for booking ID / Guest name input field...");

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
    await dualLogInfo(`Entering booking ID: ${bookingId} in search field`);
    await page.click(BOOKING_SEARCH.INPUT, { clickCount: 3 }); // Triple click to select all
    await delay(500);
    await page.type(BOOKING_SEARCH.INPUT, bookingId, { delay: 100 });
    await delay(1000);

    // Step 2: Click the Search button
    await dualLogInfo("Clicking Search button...");

    try {
      await page.waitForSelector(BOOKING_SEARCH.BUTTON, {
        visible: true,
        timeout: 5000,
      });
      await page.click(BOOKING_SEARCH.BUTTON);
      await dualLogInfo("Search button clicked");
    } catch (error) {
      await dualLogError("Search button not found or not clickable", error);
      return false;
    }

    // Step 3: Wait for search results to load
    await dualLogInfo("Waiting for search results to load...");
    await delay(3000); // Initial wait

    // Wait for the booking result row to appear
    const bookingRowSelector = BOOKING_RESULTS.ROW(bookingId);

    try {
      await page.waitForSelector(bookingRowSelector, {
        visible: true,
        timeout: 15000,
      });
      await dualLogInfo(`Booking row found for ID: ${bookingId}`);
    } catch (error) {
      await dualLogError(`Booking row not found for ID: ${bookingId}`, error);
      return false;
    }

    // Step 4: Click on the booking row (preferably on the guest name)
    await dualLogInfo("Clicking on booking row (guest name)...");

    // Try to click on the guest name first, fallback to the row
    const guestNameSelector = BOOKING_RESULTS.GUEST_NAME(bookingId);

    try {
      const guestNameElement = await page.$(guestNameSelector);
      if (guestNameElement) {
        await guestNameElement.click();
        await dualLogInfo("Clicked on guest name");
      } else {
        // Fallback to clicking the row itself
        await page.click(bookingRowSelector);
        await dualLogInfo("Clicked on booking row");
      }
    } catch (error) {
      await dualLogError("Failed to click on booking row", error);
      return false;
    }

    // Step 5: Wait for the right sidebar to appear
    await dualLogInfo("Waiting for booking detail sidebar to appear...");
    await delay(2000);

    // Wait for the tab list to be visible (indicates sidebar is open)
    try {
      await page.waitForSelector(BOOKING_DETAIL.TAB_LIST, {
        visible: true,
        timeout: 10000,
      });
      await dualLogInfo("Booking detail sidebar appeared");
    } catch (error) {
      await dualLogError("Booking detail sidebar did not appear", error);
      return false;
    }

    // Step 6: Click on "Get payout (UPC)" tab
    await dualLogInfo("Clicking on 'Get payout (UPC)' tab...");

    try {
      await page.waitForSelector(BOOKING_DETAIL.PAYOUT_TAB, {
        visible: true,
        timeout: 5000,
      });
      await page.click(BOOKING_DETAIL.PAYOUT_TAB);
      await dualLogInfo("Successfully clicked on 'Get payout (UPC)' tab");
      await delay(2000);
    } catch (error) {
      await dualLogError("Failed to click on 'Get payout (UPC)' tab", error);
      return false;
    }

    // Step 7: Check if OTP verification is required (iframe with login form)
    await dualLogInfo("Checking if OTP verification is required...");

    try {
      // Wait for iframe to appear (if it redirects to login)
      await delay(3000);

      // Check if there's an iframe with the login/OTP form
      const iframes = await page.frames();
      let otpFrame = null;

      for (const frame of iframes) {
        try {
          // Check if this frame contains the OTP verification form
          const hasOtpForm = await frame.evaluate((selectors) => {
            // Check for OTP verification method selection
            const otpOptionEmail = document.querySelector(
              selectors.EMAIL_OPTION
            );
            // Check for OTP input form
            const otpInputs = document.querySelector(selectors.FIRST_INPUT);
            return !!(otpOptionEmail || otpInputs);
          }, OTP_CHECK_SELECTORS);

          if (hasOtpForm) {
            otpFrame = frame;
            await dualLogInfo("Found OTP verification iframe");
            break;
          }
        } catch (frameError) {
          // Frame might not be accessible, continue checking other frames
          continue;
        }
      }

      // If no iframe found, check the main page
      if (!otpFrame) {
        await dualLogInfo("No OTP iframe found, checking main page...");
        const hasOtpOnMainPage = await page.evaluate((selectors) => {
          const otpOptionEmail = document.querySelector(selectors.EMAIL_OPTION);
          const otpInputs = document.querySelector(selectors.FIRST_INPUT);
          return !!(otpOptionEmail || otpInputs);
        }, OTP_CHECK_SELECTORS);

        if (hasOtpOnMainPage) {
          await dualLogInfo("OTP form found on main page");
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
        } else {
          await dualLogInfo(
            "No OTP verification required - proceeding to scrape UPC widget data"
          );
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
      }

      // Step 8: If no OTP verification was needed, or after OTP is completed, scrape UPC widget data
      await dualLogInfo("Checking for UPC widget data...");
      await delay(2000); // Wait for page/widget to load

      const upcData = await scrapeUpcWidgetData(page, bookingId);
      if (upcData) {
        await dualLogInfo("✅ UPC widget data scraped successfully");
        console.log("=== UPC Widget Data ===");
        console.log("Card Holder Name:", upcData.cardHolderName);
        console.log("Card Number:", upcData.cardNumber);
        console.log("Expiration Date:", upcData.expirationDate);
        console.log("CVC Code:", upcData.cvcCode);
        console.log("======================");
      } else {
        await dualLogInfo("UPC widget data not found or not accessible");
      }
    } catch (error) {
      await dualLogError("Error checking for OTP verification", error);
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
        }
      } catch (scrapeError) {
        await dualLogError("Error scraping UPC widget data", scrapeError);
      }
    }

    await dualLogInfo(
      `✅ Successfully navigated to Get payout (UPC) tab for booking ID: ${bookingId}`
    );
    return true;
  } catch (error: any) {
    await dualLogError(
      `Error in searchBookingAndNavigateToPayout for booking ID ${bookingId}:`,
      error
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
  const targetPage = frame || page;
  const selectorTimeout = 30000;

  try {
    await dualLogInfo("🔐 Processing OTP verification for Get payout (UPC)...");

    // Step 1: Check if we need to select verification method (via Email)
    await dualLogInfo("Checking for OTP verification method selection...");

    try {
      await targetPage.waitForSelector(OTP_VERIFICATION.EMAIL_OPTION, {
        visible: true,
        timeout: 5000,
      });

      await dualLogInfo(
        "Found OTP verification method selection, clicking 'via Email'..."
      );
      await targetPage.click(OTP_VERIFICATION.EMAIL_OPTION);
      await delay(2000); // Wait for OTP form to appear
    } catch (error) {
      await dualLogInfo(
        "No verification method selection found, OTP form may already be visible"
      );
    }

    // Step 2: Wait for OTP input fields to be visible
    await dualLogInfo("Waiting for OTP input fields...");

    try {
      await targetPage.waitForSelector(OTP_VERIFICATION.FIRST_INPUT, {
        visible: true,
        timeout: selectorTimeout,
      });
      await dualLogInfo("OTP input fields found");
    } catch (error) {
      await dualLogInfo(
        "OTP input fields not found, OTP verification may not be required"
      );
      return true; // Not an error - OTP might not be needed
    }

    // Step 3: Wait 60 seconds for OTP email to arrive
    await dualLogInfo("Waiting 60 seconds for OTP email delivery...");
    await delay(60000);

    // Step 4: Fetch OTP code from email
    if (!userEmail) {
      await dualLogError(
        "User email (agodausername) is required for OTP verification"
      );
      return false;
    }

    await dualLogInfo(
      `Now fetching YCS retrieval OTP code from email for ${userEmail}...`
    );

    let otpResult: any = null;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await dualLogInfo(
        `Attempt ${attempt}/${maxRetries} to fetch YCS retrieval OTP code...`
      );

      // Fetch the OTP code from email using YCS retrieval email helper
      otpResult = await getYcsRetrievalOtpCode(userEmail, 5);

      if (otpResult.otpCode) {
        await dualLogInfo(
          `OTP code found on attempt ${attempt}: ${otpResult.otpCode}`
        );
        break;
      }

      if (attempt < maxRetries) {
        await dualLogInfo(
          `Attempt ${attempt} failed, waiting 10 seconds before retry...`
        );
        await delay(10000);
      }
    }

    if (!otpResult || !otpResult.emailFound) {
      await dualLogError("Failed to access email for OTP code");
      return false;
    }

    if (!otpResult.otpCode) {
      await dualLogError(
        "OTP code not found in recent emails after all attempts"
      );
      return false;
    }

    // Step 5: Fill OTP code into the input fields
    await dualLogInfo(`Filling OTP code: ${otpResult.otpCode}`);

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
      await dualLogInfo(`Filling OTP box ${i} with digit: ${otpDigits[i]}`);

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
        await dualLogError(`Failed to fill OTP box ${i}`, inputError);
        return false;
      }
    }

    await dualLogInfo("All OTP digits filled successfully");
    await delay(1000);

    // Step 6: Click the Submit OTP button
    await dualLogInfo("Looking for Submit OTP button...");

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
      await dualLogInfo("Submit OTP button clicked successfully!");
      await delay(3000); // Wait for submission to process
    } catch (error) {
      await dualLogError("Failed to click Submit OTP button", error);
      return false;
    }

    await dualLogInfo("✅ OTP verification completed successfully");
    return true;
  } catch (error: any) {
    await dualLogError("Error in handleOtpVerification:", error);
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
  try {
    await dualLogInfo(`Scraping UPC widget data for booking ID: ${bookingId}`);

    // Wait for UPC widget to be visible
    try {
      await page.waitForSelector(UPC_WIDGET.CONTAINER, {
        visible: true,
        timeout: 10000,
      });
      await dualLogInfo("UPC widget found");
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

    await dualLogInfo("UPC widget data extracted successfully");
    return upcData;
  } catch (error: any) {
    await dualLogError("Error scraping UPC widget data:", error);
    return null;
  }
}
