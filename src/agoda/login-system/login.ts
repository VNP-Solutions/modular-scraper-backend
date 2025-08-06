import { Browser, Page } from "puppeteer";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { timeoutManager } from "../../common/timeout-manager.js";
import { getAgodaSignInLink } from "./email-link-helper.js";

async function agodaLogin(
  browser: Browser,
  page: Page,
  agodaUsername: string,
  agodaPassword: string,
  jobId?: string
): Promise<void> {
  let shouldCloseBrowser = false;

  try {
    // Get timeout configuration for this job
    const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);
    const selectorTimeout = await timeoutManager.getSelectorTimeout(jobId);
    await dualLogInfo("Starting Agoda login process with iframe handling");

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

      // Wait for "check your email" message
      await dualLogInfo("Looking for 'check your email' message...");
      await frame.waitForSelector('div[data-cy="check-your-email"]', {
        timeout: loadingTimeout,
      });

      await dualLogInfo("Check your email message appeared!");
    } catch (pageError) {
      await dualLogError("Error during page interaction:", pageError);
      shouldCloseBrowser = true;
      throw pageError;
    }

    // Email processing and navigation
    try {
      // Wait 40 seconds for email to arrive in inbox
      await dualLogInfo("Waiting 30 seconds for email delivery...");
      await new Promise((resolve) => setTimeout(resolve, 30000));

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
        throw new Error("Failed to access email for sign-in link");
      }

      if (!signInResult.signInLink) {
        throw new Error(
          "Sign-in link not found in recent emails after all attempts. Please check if you received the Agoda sign-in email."
        );
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

      await dualLogInfo("Agoda login process completed successfully!");
    } catch (emailError) {
      await dualLogError(
        "Error during email processing or navigation:",
        emailError
      );
      shouldCloseBrowser = true;
      throw emailError;
    }
  } catch (error) {
    await dualLogError("Critical error during Agoda login process:", error);

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

export default agodaLogin;
