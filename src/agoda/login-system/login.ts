import { Browser, Page } from "puppeteer";
import { delay } from "../../common/delay.js";
import {
  FAILED_REASON,
  hasFailedReasonCode,
  inferAgodaOtpFailedReasonCode,
  setFailedReasonCode,
} from "../../common/failed-reason.js";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { progressManager } from "../../common/progress-manager.js";
import { takeScreenshot } from "../../common/screenshot-helper.js";
import { timeManager } from "../../common/time-manager.js";
import { timeoutManager } from "../../common/timeout-manager.js";
import { cleanupOnError } from "../utils/error-cleanup.js";
import { getAgodaSignInLink } from "./email-link-helper.js";
import { getAgodaOtpCode } from "./email-otp-helper.js";

async function agodaLogin(
  browser: Browser,
  page: Page,
  agodaUsername: string,
  agodaPassword: string,
  jobId?: string,
  entityId?: string,
  entityType: "job" | "retrieval" = "job"
): Promise<void> {
  let shouldCloseBrowser = false;

  try {
    // Get timeout configuration for this job
    const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);
    const selectorTimeout = await timeoutManager.getSelectorTimeout(jobId);
    await dualLogInfo("Starting Agoda login process with iframe handling", {
      jobId,
      timeSession: timeManager.getSessionInfo(),
    });

    // Update progress - login process started
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        16,
        "agoda_login_process_started",
        undefined
      );
    }

    // Check if scraping is paused before starting
    // await scrapingStateManager.waitWhilePaused();
    // if (!scrapingStateManager.isRunning()) {
    //   await dualLogError("Scraping was stopped during Agoda login");
    //   throw new Error("Scraping was stopped during Agoda login");
    // }

    // Page and iframe initialization
    try {
      await dualLogInfo("Waiting for page to load...");
      await page.waitForSelector("body", { timeout: loadingTimeout });

      // Wait for the iframe to appear
      const frameElement = await page.waitForSelector(
        'iframe[data-cy="ul-app-frame"]',
        { timeout: selectorTimeout }
      );

      if (!frameElement) {
        throw new Error("Iframe element not found");
      }

      // Get the content frame
      const frame = await frameElement.contentFrame();
      if (!frame) {
        throw new Error("Could not access iframe content");
      }

      await dualLogInfo("Iframe content accessible");

      // Take screenshot after iframe access
      if (jobId || entityId) {
        await takeScreenshot(page, entityId ?? jobId ?? "", "iframe_accessed", "step", "agoda", entityType);
      }

      // Update progress - iframe accessed
      if (jobId) {
        await progressManager.updateJobProgress(
          jobId,
          undefined,
          18,
          "agoda_iframe_accessed",
          undefined
        );
      }

      // Wait for the iframe content to load
      await frame.waitForSelector("body", { timeout: loadingTimeout });

      // Email input handling
      await dualLogInfo("Looking for email input field in iframe...");
      const emailInput = await frame.waitForSelector(
        '[data-cy="unified-email-input"]',
        { timeout: selectorTimeout }
      );

      if (!emailInput) {
        throw new Error("Email input field not found in iframe");
      }

      await dualLogInfo("Email input field found in iframe");

      // Click on the input field to focus it
      await emailInput.click();

      // Clear any existing value
      await frame.evaluate(() => {
        const inputElement = document.querySelector(
          '[data-cy="unified-email-input"]'
        ) as HTMLInputElement;
        if (inputElement) {
          inputElement.value = "";
          inputElement.focus();
          // Trigger events for React
          inputElement.dispatchEvent(new Event("input", { bubbles: true }));
          inputElement.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });

      await dualLogInfo("Entering email address...");

      // Type the email character by character
      for (let i = 0; i < agodaUsername.length; i++) {
        await emailInput.type(agodaUsername[i], { delay: 150 });

        // Log progress every few characters
        if (i % 5 === 0 || i === agodaUsername.length - 1) {
          await dualLogInfo(
            `Typed ${i + 1}/${agodaUsername.length} characters`
          );
        }
      }

      await dualLogInfo(`Successfully entered email: ${agodaUsername}`);

      // Take screenshot after email entry
      if (jobId || entityId) {
        await takeScreenshot(page, entityId ?? jobId ?? "", "email_entered", "step", "agoda", entityType);
      }

      // Update progress - email entered
      if (jobId) {
        await progressManager.updateJobProgress(
          jobId,
          undefined,
          20,
          "agoda_email_entered",
          undefined
        );
      }

      // Log time session info before continuing
      await dualLogInfo("Time session info after email entry", {
        timeSession: timeManager.getSessionInfo(),
        jobId,
      });

      // Continue button handling
      await dualLogInfo("Looking for continue button in iframe...");
      const continueButton = await frame.waitForSelector(
        'button[data-cy="unified-email-continue-button"]',
        { timeout: selectorTimeout }
      );

      if (!continueButton) {
        throw new Error("Continue button not found in iframe");
      }

      // Wait for button to become enabled
      await dualLogInfo("Waiting for continue button to be enabled...");
      await frame.waitForFunction(
        () => {
          const button = document.querySelector(
            'button[data-cy="unified-email-continue-button"]'
          ) as HTMLButtonElement;
          return button && !button.disabled;
        },
        { timeout: selectorTimeout }
      );

      // Click the continue button
      await continueButton.click();
      await dualLogInfo("Continue button clicked successfully!");

      // Take screenshot after continue button clicked
      if (jobId || entityId) {
        await takeScreenshot(page, entityId ?? jobId ?? "", "continue_button_clicked", "step", "agoda", entityType);
      }

      // Update progress - continue button clicked
      if (jobId) {
        await progressManager.updateJobProgress(
          jobId,
          undefined,
          22,
          "agoda_continue_button_clicked",
          undefined
        );
      }

      // Wait for either "check your email" message or OTP form
      await dualLogInfo("Waiting for next page (email link or OTP form)...");

      // Use Promise.race to wait for either outcome
      const nextPageResult = await Promise.race([
        // Option 1: Check your email message (for direct link)
        frame
          .waitForSelector('div[data-cy="check-your-email"]', {
            timeout: loadingTimeout,
          })
          .then(() => "email-link"),

        // Option 2: OTP form appears
        frame
          .waitForSelector('div[data-cy="unified-auth-otp-form"]', {
            timeout: loadingTimeout,
          })
          .then(() => "otp-form"),

        // Option 3: OTP heading appears
        frame
          .waitForSelector('h2:has-text("Sign in with OTP")', {
            timeout: loadingTimeout,
          })
          .then(() => "otp-form"),
      ]);

      await dualLogInfo(`Next page result: ${nextPageResult}`);

      // Handle different login flows based on next page result
      if (nextPageResult === "email-link") {
        await dualLogInfo("✅ Direct email link flow detected");
        try {
          await handleDirectLinkFlow(page, jobId);

          // For retrieval jobs, don't release OTP yet - wait for payout verification
          // OTP will be released after payout verification completes
          if (jobId) {
            await dualLogInfo(
              "OTP kept occupied - will release after payout verification (retrieval job)"
            );
          }
        } catch (directLinkError: any) {
          await dualLogError(
            "Error during direct email link flow:",
            directLinkError
          );
          if (!hasFailedReasonCode(directLinkError)) {
            setFailedReasonCode(
              directLinkError,
              FAILED_REASON.AGODA_EMAIL_LINK_NOT_FOUND
            );
          }
          throw directLinkError;
        }
      } else if (nextPageResult === "otp-form") {
        await dualLogInfo("✅ OTP form flow detected");
        try {
          await handleOtpFlow(
            frame,
            loadingTimeout,
            selectorTimeout,
            page,
            jobId,
            entityId,
            entityType
          );

          // For retrieval jobs, don't release OTP yet - wait for payout verification
          // OTP will be released after payout verification completes
          if (jobId) {
            await dualLogInfo(
              "OTP kept occupied - will release after payout verification (retrieval job)"
            );
          }
        } catch (otpError: any) {
          await dualLogError("Error during OTP flow:", otpError);

          // Take error screenshot for OTP flow error
          if (jobId || entityId) {
            try {
              // Use the main page instead of trying to access from frame
              await takeScreenshot(page, entityId ?? jobId ?? "", "otp_flow_error", "error", "agoda", entityType);
            } catch (screenshotError) {
              await dualLogError(
                "Failed to take OTP flow error screenshot:",
                screenshotError
              );
            }
          }

          if (!hasFailedReasonCode(otpError)) {
            setFailedReasonCode(
              otpError,
              inferAgodaOtpFailedReasonCode(otpError?.message)
            );
          }
          throw otpError;
        }
      } else {
        throw new Error(`Unknown next page result: ${nextPageResult}`);
      }

      await dualLogInfo("Agoda login process completed successfully!");

      // Final login progress update
      if (jobId) {
        await progressManager.updateJobProgress(
          jobId,
          undefined,
          24,
          "agoda_login_completed",
          undefined
        );
      }
    } catch (pageError) {
      await dualLogError("Error during page interaction:", pageError);
      shouldCloseBrowser = true;

      // Take error screenshot for page interaction error
      if (jobId || entityId) {
        try {
          await takeScreenshot(page, entityId ?? jobId ?? "", "page_interaction_error", "error", "agoda", entityType);
        } catch (screenshotError) {
          await dualLogError(
            "Failed to take page interaction error screenshot:",
            screenshotError
          );
        }
      }

      // For retrieval jobs, don't release OTP on error - let it be handled by cleanup
      // OTP will be released after payout verification or job completion
      if (jobId) {
        await dualLogInfo(
          "OTP kept occupied after login error - will be released after payout verification or job completion (retrieval job)"
        );
      }
      if (!hasFailedReasonCode(pageError)) {
        setFailedReasonCode(pageError, FAILED_REASON.AGODA_LOGIN_FAILED);
      }
      throw pageError;
    }
  } catch (error) {
    await dualLogError("Critical error during Agoda login process:", error);

    // Take error screenshot for critical login error
    if ((jobId || entityId) && browser) {
      try {
        const pages = await browser.pages();
        const activePage = pages.find((p) => !p.isClosed()) || pages[0];
        if (activePage) {
          await takeScreenshot(activePage, entityId ?? jobId ?? "", "critical_login_error", "error", "agoda", entityType);
        }
      } catch (screenshotError) {
        await dualLogError(
          "Failed to take critical login error screenshot:",
          screenshotError
        );
      }
    }

    // For retrieval jobs, don't release OTP on error - let it be handled by cleanup
    // OTP will be released after payout verification or job completion
    if (jobId) {
      await dualLogInfo(
        "OTP kept occupied after critical login error - will be released after payout verification or job completion (retrieval job)"
      );
    }
    // Standardized cleanup on login error
    try {
      await dualLogInfo("Starting standardized cleanup due to login error", {
        jobId,
        timeSession: timeManager.getSessionInfo(),
      });

      const cleanupResult = await cleanupOnError(jobId, {
        operation: "agoda_login_error",
      });

      await dualLogInfo("Standardized cleanup completed after login error", {
        jobId,
        downloadFilesCleanedCount: cleanupResult.downloadFilesCleanedCount,
        exportFilesCleanedCount: cleanupResult.exportFilesCleanedCount,
        foldersRemovedCount: cleanupResult.foldersRemovedCount,
        totalFilesProcessed: cleanupResult.totalFilesProcessed,
        errors: cleanupResult.errors.length,
        timeSession: timeManager.getSessionInfo(),
      });
    } catch (cleanupError: any) {
      await dualLogError(
        "Error during standardized cleanup (continuing with error handling):",
        cleanupError.message,
        { jobId }
      );
      // Don't throw cleanup error - continue with original error handling
    }

    // Clean up browser if needed
    if (shouldCloseBrowser && browser) {
      try {
        await dualLogInfo("Cleaning up browser due to error...");
        await browser.close();
        await dualLogInfo("Browser closed successfully");
      } catch (cleanupError) {
        await dualLogError("Error closing browser:", cleanupError);
      }
    }

    throw error;
  } finally {
    // Final cleanup attempt if browser is still open
    try {
      if (browser && !browser.isConnected()) {
        await dualLogInfo(
          "Browser appears to be disconnected, skipping cleanup"
        );
      } else if (shouldCloseBrowser && browser) {
        await browser.close();
        await dualLogInfo("Browser closed in finally block");
      }
    } catch (finalCleanupError) {
      await dualLogError("Error in final browser cleanup:", finalCleanupError);
    }
  }
}

/**
 * Handle direct email link flow (existing functionality)
 */
async function handleDirectLinkFlow(page: Page, jobId?: string): Promise<void> {
  // Wait 60 seconds for email to arrive in inbox
  await dualLogInfo("Waiting 60 seconds for email delivery...");

  // Update progress - waiting for email
  if (jobId) {
    await progressManager.updateJobProgress(
      jobId,
      undefined,
      23,
      "agoda_waiting_for_email_link",
      undefined
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 60000));

  await dualLogInfo("Now fetching sign-in link from email...");

  // Try multiple attempts to find the sign-in link
  let signInResult: any = null;
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await dualLogInfo(
      `Attempt ${attempt}/${maxRetries} to fetch sign-in link...`
    );

    // Fetch the sign-in link from email (check 5 recent emails)
    signInResult = await getAgodaSignInLink(5);

    if (signInResult.signInLink) {
      await dualLogInfo(`Sign-in link found on attempt ${attempt}`);
      break;
    }

    if (attempt < maxRetries) {
      await dualLogInfo(
        `Attempt ${attempt} failed, waiting 10 seconds before retry...`
      );
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }

  if (!signInResult || !signInResult.emailFound) {
    const err = new Error("Failed to access email for sign-in link");
    setFailedReasonCode(err, FAILED_REASON.AGODA_EMAIL_LINK_NOT_FOUND);
    throw err;
  }

  if (!signInResult.signInLink) {
    const err = new Error(
      "Sign-in link not found in recent emails after all attempts. Please check if you received the Agoda sign-in email."
    );
    setFailedReasonCode(err, FAILED_REASON.AGODA_EMAIL_LINK_NOT_FOUND);
    throw err;
  }

  await dualLogInfo(`Sign-in link found: ${signInResult.signInLink}`);
  if (signInResult.emailSubject) {
    await dualLogInfo(`Email subject: ${signInResult.emailSubject}`);
  }

  // Navigate to the sign-in link
  await dualLogInfo("Navigating to sign-in link...");
  await page.goto(signInResult.signInLink, {
    waitUntil: "networkidle2",
    timeout: 50000,
  });

  // Wait 10 seconds after navigating to the sign-in link
  await dualLogInfo("Waiting 10 seconds after navigating to sign-in link...");
  await delay(10000);
}

/**
 * Handle OTP form flow (new functionality)
 */
async function handleOtpFlow(
  frame: any,
  loadingTimeout: number,
  selectorTimeout: number,
  page: Page,
  jobId?: string,
  entityId?: string,
  entityType: "job" | "retrieval" = "job"
): Promise<void> {
  await dualLogInfo("🔐 Processing OTP form...");

  // Wait for OTP input fields to be visible
  await dualLogInfo("Waiting for OTP input fields...");
  await frame.waitForSelector('input[data-cy="otp-box-0"]', {
    timeout: selectorTimeout,
  });

  // Extract reference code and email address from the page
  await dualLogInfo("Extracting reference code and email address from page...");
  let referenceCode: string | null = null;
  let recipientEmail: string | null = null;

  try {
    // Extract reference code
    try {
      await frame.waitForSelector('[data-cy="unified-auth-otp-refcode"]', {
        timeout: selectorTimeout,
      });

      referenceCode = await frame.evaluate(() => {
        const refElement = document.querySelector(
          '[data-cy="unified-auth-otp-refcode"]'
        );
        if (refElement) {
          const text = refElement.textContent?.trim() || "";
          // Extract the code part (e.g., "Ref #lwUsBf" -> "lwUsBf")
          const patterns = [
            /Ref\s*#\s*([A-Za-z0-9]+)/i, // "Ref #lwUsBf"
            /#Ref:\s*([A-Za-z0-9]+)/i, // "#Ref: lwUsBf"
            /#\s*([A-Za-z0-9]+)/i, // "#lwUsBf"
          ];

          for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match && match[1]) {
              return match[1];
            }
          }

          // Fallback: remove "Ref" and "#" prefixes
          return text.replace(/^Ref\s*#?\s*/i, "").trim();
        }
        return null;
      });

      if (referenceCode) {
        await dualLogInfo(`✅ Reference code extracted: ${referenceCode}`);
      } else {
        await dualLogInfo("⚠️ Could not extract reference code from page");
      }
    } catch (refError) {
      await dualLogError(
        "Error extracting reference code (will search without it):",
        refError
      );
    }

    // Extract email address from sub-heading
    try {
      const subHeadingElement = await frame.$('[data-cy="form-sub-heading"]');
      if (subHeadingElement) {
        recipientEmail = await frame.evaluate((element: Element) => {
          const text = element.textContent || "";
          // Extract email from text like "Enter the OTP provided in the email sent to chartwell@epchotels.com."
          const emailMatch = text.match(
            /to\s+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i
          );
          return emailMatch ? emailMatch[1] : null;
        }, subHeadingElement);

        if (recipientEmail) {
          await dualLogInfo(`✅ Recipient email extracted: ${recipientEmail}`);
        } else {
          await dualLogInfo("⚠️ Could not extract recipient email from page");
        }
      }
    } catch (emailError) {
      await dualLogError(
        "Error extracting recipient email (will search without it):",
        emailError
      );
    }
  } catch (error) {
    await dualLogError(
      "Error extracting page information (will search without filters):",
      error
    );
  }

  // Wait 60 seconds for OTP email to arrive
  await dualLogInfo("Waiting 60 seconds for OTP email delivery...");

  // Update progress - waiting for OTP email
  if (jobId) {
    await progressManager.updateJobProgress(
      jobId,
      undefined,
      23,
      "agoda_waiting_for_otp_email",
      undefined
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 60000));

  await dualLogInfo("Now fetching OTP code from email...");

  // Try multiple attempts to find the OTP code
  let otpResult: any = null;
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await dualLogInfo(`Attempt ${attempt}/${maxRetries} to fetch OTP code...`);

    // Fetch the OTP code from email (check 10 recent emails, with reference code and recipient email if available)
    // Increased to 10 to ensure we catch the email even if it arrives slightly later
    otpResult = await getAgodaOtpCode(
      10,
      referenceCode || undefined,
      recipientEmail || undefined
    );

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
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }

  if (!otpResult || !otpResult.emailFound) {
    const err = new Error("Failed to access email for OTP code");
    setFailedReasonCode(err, FAILED_REASON.AGODA_OTP_CODE_NOT_FOUND);
    throw err;
  }

  if (!otpResult.otpCode) {
    const err = new Error(
      "OTP code not found in recent emails after all attempts. Please check if you received the Agoda OTP email."
    );
    setFailedReasonCode(err, FAILED_REASON.AGODA_OTP_CODE_NOT_FOUND);
    throw err;
  }

  // Fill OTP code into the input fields
  await dualLogInfo(`Filling OTP code: ${otpResult.otpCode}`);

  // Split the 6-digit code into individual digits
  const otpDigits = otpResult.otpCode.split("");

  if (otpDigits.length !== 6) {
    throw new Error(
      `Invalid OTP code length: ${otpDigits.length}. Expected 6 digits.`
    );
  }

  // Fill each OTP input field
  for (let i = 0; i < 6; i++) {
    const inputSelector = `input[data-cy="otp-box-${i}"]`;
    await dualLogInfo(`Filling OTP box ${i} with digit: ${otpDigits[i]}`);

    // Wait for the input field
    await frame.waitForSelector(inputSelector, { timeout: selectorTimeout });

    // Focus and clear the field
    await frame.focus(inputSelector);
    await frame.evaluate((selector: string) => {
      const input = document.querySelector(selector) as HTMLInputElement;
      if (input) {
        input.value = "";
        input.focus();
      }
    }, inputSelector);

    // Type the digit
    await frame.type(inputSelector, otpDigits[i], { delay: 150 });
  }

  await dualLogInfo("All OTP digits filled successfully");

  // Take screenshot after OTP digits are filled (using main page)
  if (jobId || entityId) {
    try {
      // Use the main page instead of trying to access from frame
      await takeScreenshot(page, entityId ?? jobId ?? "", "otp_digits_filled", "step", "agoda", entityType);
    } catch (screenshotError) {
      await dualLogError(
        "Failed to take OTP digits filled screenshot:",
        screenshotError
      );
    }
  }

  // Wait for continue button to become enabled
  await dualLogInfo("Waiting for OTP continue button to be enabled...");
  await frame.waitForFunction(
    () => {
      const button = document.querySelector(
        'button[data-cy="unified-auth-otp-continue-button"]'
      ) as HTMLButtonElement;
      return button && !button.disabled;
    },
    { timeout: selectorTimeout }
  );

  // Click the continue button
  const otpContinueButton = await frame.waitForSelector(
    'button[data-cy="unified-auth-otp-continue-button"]',
    { timeout: selectorTimeout }
  );

  if (!otpContinueButton) {
    throw new Error("OTP continue button not found");
  }

  await otpContinueButton.click();
  await dualLogInfo("OTP continue button clicked successfully!");

  // Take screenshot after OTP continue button clicked
  if (jobId || entityId) {
    try {
      // Use the main page instead of trying to access from frame
      await takeScreenshot(page, entityId ?? jobId ?? "", "otp_verification_completed", "step", "agoda", entityType);
    } catch (screenshotError) {
      await dualLogError(
        "Failed to take OTP verification completed screenshot:",
        screenshotError
      );
    }
  }

  // Wait for successful login (page should redirect)
  await dualLogInfo("Waiting for login completion...");
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

export default agodaLogin;
