import dotenv from "dotenv";
import { Browser, Page } from "puppeteer";
import { browserSetupLocal } from "./browser-setup/browser-local.js";
import { browserSetupProduction } from "./browser-setup/browser-prod.js";
import { delay } from "./common/delay.js";
import { decryptPassword } from "./common/encription.js";
import { dualLogError, dualLogInfo } from "./common/log-helper.js";
import { otpCompletionNotifier } from "./common/otp-completion-notifier.js";
import { scrapingStateManager } from "./common/scraping-state.js";
import { processReservationIds } from "./expedia-payments/by-reservation-id.js";
import { clickExpediaPaymentandsetDaterange } from "./expedia-payments/expedia-payments.js";
import { splitDateRange } from "./expedia-payments/split-date-range.js";
import login from "./login/login.js";
import { Job } from "./models/job.model.js";
import handleOtpVerification from "./otp-verification/otp-verification.js";
import { propertySearchAndClickPayments } from "./property-search/property-search.js";

dotenv.config();

//MARK: This is the ectry function for the db scraping.
// It will scrape the db for the given expediaId, startDate, endDate, jobId, user_email, user_password which 
async function dbScraping(
  expediaId?: string,
  startDate?: string,
  endDate?: string,
  jobId?: string,
  user_email?: string,
  user_password?: string
): Promise<void> {
  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    await dualLogInfo("Starting DB scraping...", {
      expediaId,
      startDate,
      endDate,
      jobId,
    });

    // Fetch job to get property name and db_billing_duration
    let propertyName = "Unknown Property";
    let dbBillingDuration: number | undefined = undefined;
    if (jobId) {
      try {
        const job = await Job.findById(jobId);
        if (job) {
          propertyName = job.property_name || "Unknown Property";
          dbBillingDuration = job.db_billing_duration;
          await dualLogInfo(`Fetched property name from job: ${propertyName}`);
          if (dbBillingDuration) {
            await dualLogInfo(
              `Fetched db_billing_duration from job: ${dbBillingDuration} days`
            );
          } else {
            await dualLogInfo(
              "No db_billing_duration found in job, will use default logic"
            );
          }
        }
      } catch (jobError) {
        await dualLogError("Error fetching job for property name:", jobError);
        // Continue with default property name
      }
    }

    // Step 1: Setup browser and navigate to login page
    await dualLogInfo("Setting up browser...");
    const environment = process.env.ENVIRONMENT || "browserless";
    let setupResult = null;
    if (environment === "browserless") {
      setupResult = await browserSetupProduction(jobId, "expedia");
    } else {
      setupResult = await browserSetupLocal(jobId, "expedia");
    }
    browser = setupResult.browser;
    page = setupResult.page;

    await dualLogInfo("Browser setup complete. Page is ready at login screen.");

    // Check if scraping is paused and wait if needed
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogInfo("Scraping was stopped, exiting...");
      await browser.close();
      return;
    }

    // Step 2: Check if login credentials are provided
    const email = user_email;
    const password = decryptPassword(user_password);

    if (email && password) {
      await dualLogInfo(
        "Login credentials found, performing automatic login..."
      );

      try {
        // Check pause state before login
        await scrapingStateManager.waitWhilePaused();
        if (!scrapingStateManager.isRunning()) {
          await dualLogInfo("Scraping was stopped, exiting...");
          await browser.close();
          return;
        }

        await login(browser, page, email, password, jobId);
        await dualLogInfo(
          "Login completed successfully! User is now logged in."
        );

        // Add your post-login automation here
        await dualLogInfo("Ready for scraping operations...");
        await delay(10000);
      } catch (loginError) {
        await dualLogError("Login failed:", loginError);
        // Close browser when done with this attempt
        if (browser) {
          await browser.close();
          browser = null;
        }
        await dualLogInfo("Browser closed successfully.");
        throw loginError;
      }

      try {
        // Check pause state before OTP verification
        await scrapingStateManager.waitWhilePaused();
        if (!scrapingStateManager.isRunning()) {
          await dualLogInfo("Scraping was stopped, exiting...");
          await browser.close();
          return;
        }

        await handleOtpVerification(browser, page, jobId);
        await dualLogInfo("OTP verification completed successfully!");

        // Notify worker that OTP work is completed so other jobs can proceed
        if (jobId) {
          otpCompletionNotifier.notifyOtpCompleted(jobId);
        }
      } catch (error: any) {
        await dualLogError("OTP verification failed:", error);

        // Notify that OTP work is completed (even on failure) so other jobs can proceed
        if (jobId) {
          otpCompletionNotifier.notifyOtpCompleted(jobId);
        }
        // Close browser when done with this attempt
        if (browser) {
          await browser.close();
          browser = null;
        }
        await dualLogInfo("Browser closed successfully.");
        // Continue even if OTP fails as it might not be required
        throw error;
      }

      // Step 3: Perform property search with the provided expedia ID
      if (expediaId) {
        try {
          // Check pause state before property search
          await scrapingStateManager.waitWhilePaused();
          if (!scrapingStateManager.isRunning()) {
            await dualLogInfo("Scraping was stopped, exiting...");
            await browser.close();
            return;
          }

          await dualLogInfo(
            `Starting property search for Expedia ID: ${expediaId}`
          );
          await propertySearchAndClickPayments(browser, page, expediaId, jobId);
          await dualLogInfo(
            "Property search and Payments completed successfully!"
          );
        } catch (error: any) {
          await dualLogError("Property search failed:", error);
          throw error;
        }
      } else {
        await dualLogInfo("No expedia ID provided, skipping property search.");
      }

      // Step 4: Click "Request payment from Expedia Group" and set date range
      try {
        // Check pause state before clicking payment link
        await scrapingStateManager.waitWhilePaused();
        if (!scrapingStateManager.isRunning()) {
          await dualLogInfo("Scraping was stopped, exiting...");
          await browser.close();
          return;
        }

        await dualLogInfo(
          "Clicking 'Request payment from Expedia Group' link..."
        );
        await clickExpediaPaymentandsetDaterange(
          browser,
          page,
          startDate!,
          endDate!,
          jobId
        );
        await dualLogInfo(
          "Successfully clicked payment link and ready for date range setting!"
        );
      } catch (error: any) {
        await dualLogError("Payment link click failed:", error);
        throw error;
      }

      // Step 5: Phase 1 — Collect all reservation IDs across all date range chunks
      let collectedReservationIds: string[] = [];
      try {
        // Check pause state before date range processing
        await scrapingStateManager.waitWhilePaused();
        if (!scrapingStateManager.isRunning()) {
          await dualLogInfo("Scraping was stopped, exiting...");
          await browser.close();
          return;
        }

        await dualLogInfo(
          "Phase 1: Starting date range split — collecting reservation IDs into memory..."
        );
        collectedReservationIds = await splitDateRange(
          browser,
          page,
          startDate!,
          endDate!,
          jobId,
          expediaId,
          propertyName,
          dbBillingDuration
        );
        await dualLogInfo(
          `Phase 1 complete! Collected ${collectedReservationIds.length} reservation ID(s) in memory.`
        );
      } catch (error: any) {
        await dualLogError("Phase 1 (date range collection) failed:", error);
        throw error;
      }

      // Step 6: Phase 2 — Process all collected reservation IDs in batches of 100
      try {
        // Check pause state before Phase 2
        await scrapingStateManager.waitWhilePaused();
        if (!scrapingStateManager.isRunning()) {
          await dualLogInfo("Scraping was stopped, exiting...");
          await browser.close();
          return;
        }

        await dualLogInfo(
          `Phase 2: Processing ${collectedReservationIds.length} reservation ID(s) via 'By Reservation ID' tab in batches of 100...`
        );
        await processReservationIds(
          browser,
          page,
          collectedReservationIds,
          jobId,
          expediaId,
          propertyName
        );
        await dualLogInfo("Phase 2 complete! All reservation ID batches processed.");
      } catch (error: any) {
        await dualLogError("Phase 2 (reservation ID processing) failed:", error);
        throw error;
      }

      await dualLogInfo(
        "DB scraping completed — Phase 1 (date range collection) + Phase 2 (reservation ID batches) both finished."
      );
      await delay(5000); // Give time to see the page
    }

    // Close browser when done
    if (browser) {
      await browser.close();
      await dualLogInfo("Browser closed successfully.");
    }

    await dualLogInfo("DB scraping completed successfully!");
  } catch (error) {
    await dualLogError("Error in DB scraping:", error);

    // Ensure browser is closed on error
    if (browser) {
      try {
        await browser.close();
        await dualLogInfo("Browser closed after error.");
      } catch (closeError) {
        await dualLogError("Error closing browser:", closeError);
      }
    }

    throw error;
  }
}

export default dbScraping;
