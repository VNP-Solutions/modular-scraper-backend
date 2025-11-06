import dotenv from "dotenv";
import { Browser, Page } from "puppeteer";
import { browserSetupLocal } from "./browser-setup/browser-local.js";
import { browserSetupProduction } from "./browser-setup/browser-prod.js";
import { delay } from "./common/delay.js";
import { decryptPassword } from "./common/encription.js";
import { dualLogError, dualLogInfo } from "./common/log-helper.js";
import { otpCompletionNotifier } from "./common/otp-completion-notifier.js";
import { scrapingStateManager } from "./common/scraping-state.js";
import { getDBData } from "./db-parsing/DBparsing.js";
import login from "./login/login.js";
import handleOtpVerification from "./otp-verification/otp-verification.js";

dotenv.config();

/**
 * Main DB API scraping function
 * This function handles login, OTP verification, and navigation to homepage
 * After reaching homepage, you can add your DB API scraping logic here
 */
async function dbApiScraping(
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
    await dualLogInfo("🚀 Starting DB API scraping...", {
      expediaId,
      startDate,
      endDate,
      jobId,
    });

    // Check environment and setup browser accordingly
    const environment = process.env.ENVIRONMENT || "production";
    await dualLogInfo(
      `🌍 Environment: ${environment === "production" ? "Production" : "Local"}`
    );

    if (environment === "production") {
      await dualLogInfo("🔧 Setting up Production browser...");
      const browserSetup = await browserSetupProduction(jobId, "expedia");
      browser = browserSetup.browser;
      page = browserSetup.page;
    } else {
      await dualLogInfo("🔧 Setting up Local browser...");
      const browserSetup = await browserSetupLocal(jobId, "expedia");
      browser = browserSetup.browser;
      page = browserSetup.page;
    }

    if (!page || !browser) {
      throw new Error("Failed to initialize browser and page");
    }

    await dualLogInfo("✅ Browser setup completed");

    // Step 1: Login to Expedia Partner Central
    await dualLogInfo("🔐 Starting login process...", {
      user_email,
    });

    // Check if scraping is paused before login
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogInfo("Scraping was stopped before login, exiting...");
      return;
    }

    const decryptedPassword = decryptPassword(user_password || "");
    await login(browser, page, user_email || "", decryptedPassword, jobId);
    await dualLogInfo("✅ Login completed successfully");

    // Short delay after login
    await delay(5000);

    // Step 2: OTP Verification
    await dualLogInfo("📱 Starting OTP verification...");

    try {
      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        await dualLogInfo(
          "Scraping was stopped during OTP verification, exiting..."
        );
        return;
      }

      await handleOtpVerification(browser, page, jobId);
      await dualLogInfo("✅ OTP verification completed successfully");

      // Notify worker that OTP work is completed
      if (jobId) {
        otpCompletionNotifier.notifyOtpCompleted(jobId);
      }
    } catch (otpError: any) {
      await dualLogError("OTP verification failed:", otpError);

      // Notify that OTP work is completed (even on failure)
      if (jobId) {
        otpCompletionNotifier.notifyOtpCompleted(jobId);
      }

      // Continue without OTP - it might not be required
      await dualLogInfo(
        "Continuing without OTP verification (it might not be required)"
      );
    }

    // Wait for homepage to load
    await delay(3000);

    // Step 3: Verify we're on the homepage
    const currentUrl = page.url();
    await dualLogInfo(`📍 Current URL after login: ${currentUrl}`);

    if (currentUrl.includes("lodging.expediapartnercentral.com/")) {
      await dualLogInfo(
        "✅ Successfully reached Expedia Partner Central homepage"
      );
    }

    await dualLogInfo("🔍 Starting DB API data extraction...");

    await getDBData(browser, page, expediaId, startDate, endDate, jobId);

    await dualLogInfo("📊 DB API data extraction completed");

    await dualLogInfo("✅ DB API scraping completed successfully");
  } catch (error) {
    await dualLogError("❌ Error in DB API scraping", error);
    throw error;
  } finally {
    // Cleanup
    if (browser) {
      try {
        await dualLogInfo("🧹 Cleaning up browser resources...");
        await browser.close();
        await dualLogInfo("✅ Browser closed successfully");
      } catch (closeError) {
        await dualLogError("⚠️ Error closing browser", closeError);
      }
    }
  }
}

export default dbApiScraping;
