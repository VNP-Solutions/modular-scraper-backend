import dotenv from "dotenv";
import { Page } from "puppeteer";
import { TWO_FA_TEXT_PATTERNS } from "../common/booking-selectors.js";
import { delay } from "../common/delay.js";
import {
  FAILED_REASON,
  inferBookingOtpFailedReasonCode,
  setFailedReasonCode,
} from "../common/failed-reason.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { notificationService } from "../services/notification.service.js";
import {
  getOurContactForJob,
  getOurContactFromEnv,
  setBookingOtpUseNoSlotEmailForJob,
} from "../common/job-phone-store.js";
import { getBookingVerificationCodes } from "./email-verification-utils.js";
import {
  getTimeoutConfig,
  initializeStateManager,
  submitOtpForm,
  waitForNavigation,
} from "./otp-common-utils.js";

dotenv.config();

/** Selectors tried in order when locating the Booking.com OTP input. */
const BOOKING_OTP_INPUT_SELECTORS: string[] = [
  'input[autocomplete="one-time-code"]',
  'input[type="text"][maxlength="6"]',
  'input[name="pin"]',
  'input[name="code"]',
  'input[placeholder*="code" i]',
  'input[inputmode="numeric"]',
  'input[type="text"][maxlength="5"]',
  'input[type="text"][maxlength="7"]',
  'input[type="text"][maxlength="8"]',
  'input[type="number"]',
  'input[name="otp"]',
  'input[name="verification_code"]',
  'input[name="sms_code"]',
  'input[id*="code" i]',
  'input[id*="otp" i]',
  'input[id*="pin" i]',
  'input[class*="code" i]',
  'input[class*="otp" i]',
  'input[class*="pin" i]',
  'input[class*="verification" i]',
  'input[placeholder*="Enter" i]',
  'input[placeholder*="SMS" i]',
  'input[placeholder*="PIN" i]',
  'input[placeholder*="OTP" i]',
  'input[data-testid*="code" i]',
  'input[data-testid*="otp" i]',
  'input[data-testid*="pin" i]',
  'input[type="text"]:not([type="email"]):not([type="password"])',
  'input[type="tel"]',
];

function isStalePageContextError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    msg.includes("detached Frame") ||
    msg.includes("detached frame") ||
    msg.includes("Execution context was destroyed") ||
    msg.includes("Cannot find context") ||
    msg.includes("Target closed")
  );
}

/**
 * Finds a visible OTP input on the current document. Safe to call again after navigation or reload.
 */
async function findBookingOtpInputSelector(
  page: Page,
  perSelectorTimeoutMs: number
): Promise<string | null> {
  let otpInputSelector: string | null = null;

  for (const selector of BOOKING_OTP_INPUT_SELECTORS) {
    try {
      await page.waitForSelector(selector, {
        visible: true,
        timeout: perSelectorTimeoutMs,
      });

      const element = await page.$(selector);
      if (element) {
        const isVisible = await element.isIntersectingViewport();
        const boundingBox = await element.boundingBox();

        if (isVisible && boundingBox) {
          otpInputSelector = selector;
          await dualLogInfo(`Found OTP input field: ${selector}`);
          break;
        }
        await dualLogInfo(
          `Selector ${selector} found but element not visible/interactable`
        );
      }
    } catch (e) {
      await dualLogInfo(
        `Selector ${selector} failed: ${
          e instanceof Error ? e.message : "Unknown error"
        }`
      );
    }
  }

  if (otpInputSelector) {
    return otpInputSelector;
  }

  await dualLogInfo(
    "No specific OTP selectors worked, trying generic approach..."
  );

  const fallbackResult = await page.evaluate(() => {
    const inputs = Array.from(
      document.querySelectorAll(
        'input[type="text"], input[type="number"], input[type="tel"]'
      )
    );

    for (const input of inputs) {
      const inputElement = input as HTMLInputElement;
      const maxLen = inputElement.maxLength;
      const placeholder = inputElement.placeholder?.toLowerCase() || "";
      const name = inputElement.name?.toLowerCase() || "";
      const id = inputElement.id?.toLowerCase() || "";
      const className = inputElement.className?.toLowerCase() || "";

      if (
        (maxLen > 0 && maxLen <= 10) ||
        placeholder.includes("code") ||
        placeholder.includes("otp") ||
        placeholder.includes("pin") ||
        placeholder.includes("verification") ||
        name.includes("code") ||
        name.includes("otp") ||
        name.includes("pin") ||
        id.includes("code") ||
        id.includes("otp") ||
        id.includes("pin") ||
        className.includes("code") ||
        className.includes("otp") ||
        className.includes("pin")
      ) {
        let selector = "";
        if (inputElement.name) selector = `input[name="${inputElement.name}"]`;
        else if (inputElement.id) selector = `input[id="${inputElement.id}"]`;
        else if (inputElement.className)
          selector = `input[class*="${inputElement.className.split(" ")[0]}"]`;
        else selector = 'input[type="text"]';

        return {
          found: true,
          selector,
          element: inputElement.outerHTML.substring(0, 200),
        };
      }
    }

    const firstTextInput = inputs.find((input) => {
      const inputElement = input as HTMLInputElement;
      const rect = inputElement.getBoundingClientRect();
      return (
        (inputElement.type === "text" ||
          inputElement.type === "number" ||
          inputElement.type === "tel") &&
        rect.width > 0 &&
        rect.height > 0
      );
    });

    if (firstTextInput) {
      const inputElement = firstTextInput as HTMLInputElement;
      let selector = "";
      if (inputElement.name) selector = `input[name="${inputElement.name}"]`;
      else if (inputElement.id) selector = `input[id="${inputElement.id}"]`;
      else selector = 'input[type="text"]';

      return {
        found: true,
        selector,
        element: inputElement.outerHTML.substring(0, 200),
      };
    }

    return { found: false, selector: null, element: null };
  });

  if (fallbackResult.found && fallbackResult.selector) {
    try {
      await page.waitForSelector(fallbackResult.selector, {
        visible: true,
        timeout: 5000,
      });
      otpInputSelector = fallbackResult.selector;
      await dualLogInfo(
        `Found OTP input using fallback: ${fallbackResult.selector}`
      );
      await dualLogInfo(`Element HTML: ${fallbackResult.element}`);
    } catch (e) {
      await dualLogError(
        `Fallback selector also failed: ${fallbackResult.selector}`
      );
    }
  }

  return otpInputSelector;
}

/**
 * Ensures the OTP input exists on the *current* document. Re-scans if the page reloaded (detached frame).
 */
async function ensureBookingOtpInputSelector(
  page: Page,
  preferredSelector: string | null,
  discoveryPerSelectorMs: number
): Promise<string> {
  if (preferredSelector) {
    try {
      await page.waitForSelector(preferredSelector, {
        visible: true,
        timeout: 15000,
      });
      return preferredSelector;
    } catch (e) {
      if (isStalePageContextError(e)) {
        await dualLogInfo(
          "Page context stale while waiting for OTP field; re-scanning..."
        );
      } else {
        await dualLogInfo(
          `OTP selector wait failed (${preferredSelector}), re-scanning...`
        );
      }
    }
  }

  const found = await findBookingOtpInputSelector(
    page,
    discoveryPerSelectorMs
  );
  if (!found) {
    const error = new Error(
      "OTP input field not found after exhaustive search"
    );
    setFailedReasonCode(error, FAILED_REASON.BOOKING_OTP_FAILED);
    throw error;
  }
  return found;
}

async function handleBookingOtpVerification(
  page: Page,
  jobId?: string,
  propertyId?: string
): Promise<void> {
  try {
    // Check if scraping is paused before starting OTP verification
    await initializeStateManager();

    // Get timeout configuration for this job
    const { selectorTimeout, loadingTimeout } =
      await getTimeoutConfig(/* jobId */);

    await dualLogInfo(
      "Looking for Booking.com verification method selection page..."
    );

    // Check if we're on the verification method selection page
    const isVerificationPage = await page.evaluate((patterns) => {
      const bodyText = document.body.innerText.toLowerCase();
      return patterns.some((p) => bodyText.includes(p.toLowerCase()));
    }, TWO_FA_TEXT_PATTERNS);

    if (!isVerificationPage) {
      await dualLogInfo(
        "Not on verification method selection page, checking for direct OTP input..."
      );

      // Check if we're already on an OTP input page
      const hasOtpInput =
        (await page.$('input[type="text"][maxlength="6"]')) ||
        (await page.$('input[name="pin"]')) ||
        (await page.$('input[name="code"]')) ||
        (await page.$('input[placeholder*="code"]')) ||
        (await page.$('input[autocomplete="one-time-code"]'));

      if (!hasOtpInput) {
        const error = new Error(
          "Neither verification method selection nor OTP input page found"
        );
        setFailedReasonCode(error, FAILED_REASON.BOOKING_OTP_FAILED);

        // Send public notification for OTP verification failure
        try {
          await notificationService.sendPublicNotification({
            title: "Booking.com OTP Verification Failed",
            message: `Booking.com OTP verification failed. Verification method selection or OTP input page not found. Manual intervention may be required`,
            metadata: {
              jobId,
              propertyId,
              error: error.message,
              failedAt: new Date().toISOString(),
            },
          });
        } catch (notificationError) {
          await dualLogError(
            `Error sending OTP verification failure notification: ${notificationError}`
          );
        }

        throw error;
      }
    } else {
      await dualLogInfo(
        "Found verification method selection page, clicking SMS option..."
      );

      // Click on SMS verification option
      const smsLinkClicked = await page.evaluate(() => {
        const smsLink = document.querySelector(
          ".nw-sms-verification-link"
        ) as HTMLAnchorElement;
        if (smsLink) {
          smsLink.click();
          return true;
        }
        return false;
      });

      if (!smsLinkClicked) {
        const error = new Error("SMS verification link not found");
        setFailedReasonCode(error, FAILED_REASON.BOOKING_OTP_FAILED);

        // Send public notification for OTP verification failure
        try {
          await notificationService.sendPublicNotification({
            title: "Booking.com OTP Verification Failed",
            message: `Booking.com OTP verification failed. SMS verification link not found. Manual intervention may be required`,
            metadata: {
              jobId,
              propertyId,
              error: error.message,
              failedAt: new Date().toISOString(),
            },
          });
        } catch (notificationError) {
          await dualLogError(
            `Error sending OTP verification failure notification: ${notificationError}`
          );
        }

        throw error;
      }

      await dualLogInfo(
        "Clicked SMS verification, waiting for phone selection page..."
      );
      await delay(3000);

      // Wait for navigation to phone selection page
      await page
        .waitForNavigation({
          waitUntil: "networkidle0",
          timeout: selectorTimeout,
        })
        .catch(() => {
          dualLogInfo("Navigation timeout, continuing...");
        });

      // Look for phone selection page and select the correct phone number
      const phonePick = await selectCorrectPhoneNumber(page, jobId);
      if (!phonePick.ok) {
        const error = new Error("Failed to select correct phone number");
        setFailedReasonCode(error, FAILED_REASON.BOOKING_OTP_FAILED);

        // Send public notification for OTP verification failure
        try {
          await notificationService.sendPublicNotification({
            title: "Booking.com OTP Verification Failed",
            message: `Booking.com OTP verification failed. Failed to select correct phone number. Manual intervention may be required`,
            metadata: {
              jobId,
              propertyId,
              error: error.message,
              failedAt: new Date().toISOString(),
            },
          });
        } catch (notificationError) {
          await dualLogError(
            `Error sending OTP verification failure notification: ${notificationError}`
          );
        }

        throw error;
      }

      if (phonePick.usedOurContactEnv && jobId) {
        setBookingOtpUseNoSlotEmailForJob(jobId, true);
      }

      await dualLogInfo("Phone number selected, waiting for OTP input page...");
      await delay(5000);
    }

    // Wait a bit for the page to load after clicking send button
    await delay(5000);

    // Take a screenshot for debugging
    try {
      await page.screenshot({
        path: "booking-otp-page-debug.png",
        fullPage: true,
      });
      await dualLogInfo("Screenshot saved: booking-otp-page-debug.png");
    } catch (e) {
      await dualLogInfo("Failed to take screenshot for debugging");
    }

    // Log page URL and title for debugging
    const currentUrl = page.url();
    await dualLogInfo(`Current page URL: ${currentUrl}`);

    let otpInputSelector = await findBookingOtpInputSelector(page, 3000);

    if (!otpInputSelector) {
      // Log page content for debugging
      const pageContent = await page.content();
      await dualLogInfo("Page content length:", pageContent.length);

      // Save page HTML for manual inspection
      try {
        require("fs").writeFileSync("booking-otp-page-debug.html", pageContent);
        await dualLogInfo(
          "Page HTML saved to booking-otp-page-debug.html for manual inspection"
        );
      } catch (e) {
        await dualLogInfo("Failed to save debug HTML file");
      }

      const error = new Error(
        "OTP input field not found after exhaustive search"
      );
      setFailedReasonCode(error, FAILED_REASON.BOOKING_OTP_FAILED);

      // Send public notification for OTP verification failure
      try {
        await notificationService.sendPublicNotification({
          title: "Booking.com OTP Verification Failed",
          message: `Booking.com OTP verification failed. OTP input field not found after exhaustive search. Manual intervention may be required`,
          metadata: {
            jobId,
            propertyId,
            error: error.message,
            failedAt: new Date().toISOString(),
          },
        });
      } catch (notificationError) {
        await dualLogError(
          `Error sending OTP verification failure notification: ${notificationError}`
        );
      }

      throw error;
    }

    // Wait for SMS to arrive and get verification codes from email
    await dualLogInfo("Waiting 1 minute for verification email...");
    await delay(60000); // Wait 1 minute for email to arrive

    // Get last 5 verification codes
    const codes = await getBookingVerificationCodes(jobId);
    if (!codes || codes.length === 0) {
      const error = new Error("Failed to get verification codes from email");
      setFailedReasonCode(error, FAILED_REASON.BOOKING_OTP_CODE_NOT_FOUND);

      // Send public notification for OTP verification failure
      try {
        await notificationService.sendPublicNotification({
          title: "Booking.com OTP Verification Failed",
          message: `Booking.com OTP verification failed. Failed to get verification codes from email. Manual intervention may be required`,
          metadata: {
            jobId,
            propertyId,
            error: error.message,
            failedAt: new Date().toISOString(),
          },
        });
      } catch (notificationError) {
        await dualLogError(
          `Failed to send OTP failure notification: ${notificationError}`
        );
      }

      throw error;
    }
    await dualLogInfo(`Got ${codes.length} verification codes`);

    // Long wait above: main frame may reload; always re-attach to the live OTP field.
    const otpPerSelectorMs = Math.min(8000, Math.max(4000, selectorTimeout / 4));
    await dualLogInfo(
      "Re-resolving OTP input after email wait (page may have reloaded)..."
    );
    otpInputSelector = await ensureBookingOtpInputSelector(
      page,
      otpInputSelector,
      otpPerSelectorMs
    );

    // Try up to 3 codes (1st, 2nd, 3rd)
    const maxAttempts = Math.min(3, codes.length);
    let otpSuccess = false;
    let navDetected = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const code = codes[attempt];
      await dualLogInfo(
        `Attempt ${attempt + 1}/${maxAttempts}: Trying OTP ${code}`
      );

      otpInputSelector = await ensureBookingOtpInputSelector(
        page,
        otpInputSelector,
        otpPerSelectorMs
      );

      try {
        await page.type(otpInputSelector, code, { delay: 100 });
      } catch (e) {
        if (isStalePageContextError(e)) {
          await dualLogInfo(
            "Detached frame while typing OTP; re-resolving input and retrying once..."
          );
          otpInputSelector = await ensureBookingOtpInputSelector(
            page,
            null,
            otpPerSelectorMs
          );
          await page.type(otpInputSelector, code, { delay: 100 });
        } else {
          throw e;
        }
      }
      await delay(1000);

      // Click submit button
      await submitOtpForm(page);

      // Wait for navigation or a short period so page can update after submit
      const navPromise = page
        .waitForNavigation({ timeout: 2500, waitUntil: "domcontentloaded" })
        .then(() => {
          navDetected = true;
          return true;
        })
        .catch(() => null);
      await Promise.race([navPromise, delay(2000)]);

      // Check if OTP was correct by looking for error message; guard against navigation destroying execution context
      let hasError = false;
      try {
        hasError = await page.evaluate(() => {
          const bodyText = document.body.innerText;
          return bodyText.includes("Enter a valid verification code");
        });
      } catch (e) {
        if (isStalePageContextError(e)) {
          await dualLogInfo(
            "Navigation occurred after submit; assuming OTP succeeded"
          );
          otpSuccess = true;
          navDetected = true;
          break;
        }

        throw e;
      }

      if (hasError) {
        await dualLogInfo(`Attempt ${attempt + 1} failed: Invalid OTP code`);

        // If this was the 3rd attempt, fail the job
        if (attempt === 2) {
          const error = new Error(
            "OTP verification failed after 3 attempts. All codes were invalid."
          );
          setFailedReasonCode(error, FAILED_REASON.BOOKING_OTP_FAILED);

          // Send public notification
          try {
            await notificationService.sendPublicNotification({
              title: "Booking.com OTP Verification Failed",
              message: `Booking.com OTP verification failed after 3 attempts. All OTP codes were invalid. Manual intervention required.`,
              metadata: {
                jobId,
                propertyId,
                attemptsCount: 3,
                codesTriedCount: 3,
                error: error.message,
                failedAt: new Date().toISOString(),
              },
            });
          } catch (notificationError) {
            await dualLogError(
              `Failed to send OTP failure notification: ${notificationError}`
            );
          }

          throw error;
        }

        // Clear input field after error detected, before trying next code
        await dualLogInfo("Clearing input field for next attempt...");

        // More robust clearing approach - try multiple methods
        try {
          otpInputSelector = await ensureBookingOtpInputSelector(
            page,
            otpInputSelector,
            otpPerSelectorMs
          );
          // Method 1: Triple-click to select all, then delete
          await page.click(otpInputSelector, { clickCount: 3 });
          await delay(200);
          await page.keyboard.press("Backspace");
          await delay(200);

          // Method 2: Use evaluate to clear the value directly
          await page.evaluate((selector) => {
            const input = document.querySelector(selector) as HTMLInputElement;
            if (input) {
              input.value = "";
              input.dispatchEvent(new Event("input", { bubbles: true }));
              input.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }, otpInputSelector);
          await delay(200);

          // Verify the field is actually empty
          const isEmpty = await page.evaluate((selector) => {
            const input = document.querySelector(selector) as HTMLInputElement;
            return input ? input.value === "" : false;
          }, otpInputSelector);

          if (isEmpty) {
            await dualLogInfo("✅ Input field cleared successfully");
          } else {
            await dualLogInfo(
              "⚠️ Input field may not be fully cleared, but continuing..."
            );
          }
        } catch (clearError) {
          await dualLogInfo(
            `Warning: Error during field clearing: ${clearError}`
          );
          // Continue anyway - sometimes the field clears even if we get an error
        }

        // Continue to next attempt
        continue;
      } else {
        // Success! No error message found
        await dualLogInfo(`Attempt ${attempt + 1} successful!`);
        otpSuccess = true;
        break;
      }
    }

    if (!otpSuccess) {
      const error = new Error("OTP verification failed unexpectedly");
      setFailedReasonCode(
        error,
        inferBookingOtpFailedReasonCode(error.message)
      );
      throw error;
    }

    // If navigation already occurred during submit, wait briefly for the page to settle; otherwise do the normal navigation wait
    if (navDetected) {
      try {
        await Promise.race([
          page
            .waitForNavigation({
              waitUntil: "domcontentloaded",
              timeout: Math.min(loadingTimeout, 5000),
            })
            .catch(() => null),
          delay(5000),
        ]);
      } catch (e) {
        // ignore and continue
      }
    } else {
      await waitForNavigation(page, loadingTimeout);
    }

    await dualLogInfo("Booking.com OTP verification completed!");
  } catch (error: any) {
    await dualLogError("Error in handleBookingOtpVerification:", error);

    if (!error.failedReasonCode) {
      setFailedReasonCode(
        error,
        inferBookingOtpFailedReasonCode(error?.message)
      );
    }

    // Send public notification for general OTP verification error
    try {
      await notificationService.sendPublicNotification({
        title: "Booking.com OTP Verification Failed",
        message: `Booking.com OTP verification failed. Manual intervention may be required`,
        metadata: {
          jobId,
          propertyId,
          error: error instanceof Error ? error.message : String(error),
          failedAt: new Date().toISOString(),
        },
      });
    } catch (notificationError) {
      await dualLogError(
        `Error sending OTP verification failure notification: ${notificationError}`
      );
    }

    throw error;
  }
}

function bookingPhoneLastThree(phone: string): string {
  return phone.replace(/\D/g, "").slice(-3);
}

async function selectCorrectPhoneNumber(
  page: Page,
  jobId?: string
): Promise<{ ok: boolean; usedOurContactEnv?: boolean }> {
  try {
    const primaryContact = getOurContactForJob(jobId);
    const envContact = getOurContactFromEnv();

    const attempts: { label: string; contact: string }[] = [
      { label: "job / assigned phone", contact: primaryContact },
    ];
    if (bookingPhoneLastThree(envContact) !== bookingPhoneLastThree(primaryContact)) {
      attempts.push({ label: "OUR_CONTACT env", contact: envContact });
    }

    // Wait for phone selection elements to load (once before tries)
    await delay(3000);

    let matchedByOurContactEnv = false;

    let phoneSelected:
      | {
          success: true;
          phoneNumber: string;
          method: string;
        }
      | {
          success: false;
          error?: string;
        } = { success: false, error: "No attempt" };

    for (let ai = 0; ai < attempts.length; ai++) {
      const attempt = attempts[ai];
      const lastThree = bookingPhoneLastThree(attempt.contact);
      await dualLogInfo(
        `Looking for phone number ending with: ${lastThree} (${attempt.label})`
      );

      // Options in DOM look like: +15*****0638, +16*****0408, +15*****6664 (last 3 digits identify the number)
      const result = await page.evaluate((ourContact) => {
        try {
          const targetLastThree = ourContact.replace(/\D/g, "").slice(-3);

          const phoneSelect = document.querySelector(
            'select[name="selected_phone"]'
          ) as HTMLSelectElement;
          if (phoneSelect) {
            const options = Array.from(phoneSelect.options);
            for (const option of options) {
              const phoneText = option.textContent?.trim() || "";
              const phoneLastThree = phoneText.replace(/\D/g, "").slice(-3);
              if (phoneText.includes("*") && phoneLastThree === targetLastThree) {
                phoneSelect.value = option.value;
                phoneSelect.dispatchEvent(
                  new Event("change", { bubbles: true })
                );
                return {
                  success: true,
                  phoneNumber: phoneText,
                  method: "dropdown",
                };
              }
            }
          }

          const phoneElements = document.querySelectorAll(
            'div[class*="phone"], span[class*="phone"], .verification-phone, [data-testid*="phone"], option'
          );

          for (const element of phoneElements) {
            const phoneText = element.textContent?.trim() || "";
            if (phoneText.includes("*") || phoneText.includes("••")) {
              const phoneLastThree = phoneText.replace(/\D/g, "").slice(-3);
              if (phoneLastThree === targetLastThree) {
                const clickableParent = element.closest(
                  'button, a, [role="button"], .clickable'
                ) as HTMLElement;
                if (clickableParent) {
                  clickableParent.click();
                  return {
                    success: true,
                    phoneNumber: phoneText,
                    method: "click_parent",
                  };
                }

                (element as HTMLElement).click();
                return {
                  success: true,
                  phoneNumber: phoneText,
                  method: "click_element",
                };
              }
            }
          }

          const clickableElements = document.querySelectorAll(
            'button, a, [role="button"], .clickable'
          );
          for (const element of clickableElements) {
            const text = element.textContent?.trim() || "";
            if (text.includes("*") || text.includes("••")) {
              const phoneLastThree = text.replace(/\D/g, "").slice(-3);
              if (phoneLastThree === targetLastThree) {
                (element as HTMLElement).click();
                return {
                  success: true,
                  phoneNumber: text,
                  method: "click_fallback",
                };
              }
            }
          }

          return { success: false, error: "No matching phone number found" };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          };
        }
      }, attempt.contact);

      if (
        result.success &&
        "phoneNumber" in result &&
        "method" in result &&
        result.phoneNumber &&
        result.method
      ) {
        phoneSelected = {
          success: true,
          phoneNumber: result.phoneNumber,
          method: result.method,
        };
        matchedByOurContactEnv = attempt.label === "OUR_CONTACT env";
        break;
      }

      const hasMore = ai < attempts.length - 1;
      await dualLogInfo(
        `No Booking.com option matched last 3 (${lastThree}) for ${attempt.label}${
          hasMore ? "; trying OUR_CONTACT from env" : ""
        }`
      );
    }

    if (phoneSelected.success) {
      await dualLogInfo(
        `Selected phone number: ${phoneSelected.phoneNumber} using method: ${phoneSelected.method}`
      );

      // "Send verification code" is disabled until a phone is selected; wait for it to become enabled
      await page.waitForFunction(
        () => {
          const btn = document.querySelector("button.nw-request-tfa");
          return btn && !(btn as HTMLButtonElement).disabled;
        },
        { timeout: 10000 }
      ).catch(() => null);
      await delay(500);

      const sendButtonClicked = await page.evaluate(() => {
        const sendButton = document.querySelector(
          "button.nw-request-tfa"
        ) as HTMLButtonElement;

        if (
          sendButton &&
          !sendButton.disabled &&
          sendButton.textContent?.includes("Send verification code")
        ) {
          sendButton.click();
          return true;
        }

        // Fallback: look for button with the text "Send verification code"
        const buttons = Array.from(
          document.querySelectorAll('button[type="submit"]')
        );
        for (const button of buttons) {
          if (button.textContent?.includes("Send verification code")) {
            (button as HTMLButtonElement).click();
            return true;
          }
        }

        // Final fallback: look for any submit button in the form
        const submitButton = document.querySelector(
          'form.nw-sms-verification button[type="submit"]'
        ) as HTMLButtonElement;
        if (submitButton) {
          submitButton.click();
          return true;
        }

        return false;
      });

      if (sendButtonClicked) {
        await dualLogInfo('Clicked "Send verification code" button');
        return { ok: true, usedOurContactEnv: matchedByOurContactEnv };
      } else {
        await dualLogError(
          'Failed to find and click "Send verification code" button'
        );
        return { ok: false };
      }
    } else {
      await dualLogError(`Failed to select phone: ${phoneSelected.error}`);
      return { ok: false };
    }
  } catch (error) {
    await dualLogError("Error selecting phone number:", error);
    return { ok: false };
  }
}

export default handleBookingOtpVerification;
