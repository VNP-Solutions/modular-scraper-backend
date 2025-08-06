import dotenv from "dotenv";
import { Browser } from "puppeteer";
import agodaLogin from "./agoda/login-system/login.js";
import { getAgodaBookingData } from "./agoda/booking-data/booking-data.js";
import { browserSetupLocal } from "./browser-setup/browser-local.js";
import { browserSetupProduction } from "./browser-setup/browser-prod.js";
import { emailNotifier } from "./common/email-notifier.js";
import { dualLogError, dualLogInfo } from "./common/log-helper.js";
import { progressManager } from "./common/progress-manager.js";

dotenv.config();

async function agoda(
  agodaId?: string,
  startDate?: string,
  endDate?: string,
  jobId?: string,
  agodaUsername?: string,
  agodaPassword?: string
): Promise<any[]> {
  let browser: Browser | null = null;

  try {
    await dualLogInfo("Starting Agoda automation process");

    // Validate credentials and required parameters first
    if (!agodaUsername || !agodaPassword) {
      throw new Error("Agoda username or password is not set");
    }

    if (!agodaId || !startDate || !endDate) {
      throw new Error(
        "agodaId, startDate, and endDate are required parameters"
      );
    }

    // Browser setup
    const environment = process.env.ENVIRONMENT || "production";
    await dualLogInfo(`Setting up browser for ${environment} environment`);

    let setupResult = null;
    if (environment === "production") {
      setupResult = await browserSetupProduction(jobId, "agoda");
    } else {
      setupResult = await browserSetupLocal(jobId, "agoda");
    }

    browser = setupResult.browser;
    const page = setupResult.page;
    await dualLogInfo("Browser setup completed successfully");

    // Agoda login process
    await dualLogInfo("Starting Agoda login process");
    await agodaLogin(browser, page, agodaUsername, agodaPassword, jobId);
    await dualLogInfo("Agoda login completed successfully");

    // Get booking data after successful login
    await dualLogInfo("Starting booking data retrieval");
    const bookingData = await getAgodaBookingData(
      browser,
      page,
      agodaId,
      startDate,
      endDate,
      jobId
    );

    await dualLogInfo("Agoda automation process completed successfully");
    return bookingData;
  } catch (error: any) {
    await dualLogError("Error in Agoda automation:", error);

    // Send ONE email notification per job failure
    if (jobId) {
      try {
        // Determine appropriate stage based on error
        let stage = "agoda_general_error";
        if (
          error?.message?.includes("username") ||
          error?.message?.includes("password")
        ) {
          stage = "credential_validation";
        } else if (
          error?.message?.includes("browser") ||
          error?.message?.includes("Browser")
        ) {
          stage = "agoda_browser_setup";
        } else if (
          error?.message?.includes("iframe") ||
          error?.message?.includes("email") ||
          error?.message?.includes("login")
        ) {
          stage = "agoda_login_process";
        }

        await emailNotifier.notifyJobError(
          jobId,
          error?.message || "Unknown error in Agoda automation",
          error,
          {
            stage,
            progressPercentage:
              progressManager.getJobProgress(jobId)?.progressPercentage || 0,
          }
        );
        await dualLogInfo(`Error notification email sent for stage: ${stage}`);
      } catch (emailError) {
        await dualLogError("Failed to send error notification:", emailError);
      }
    }

    throw error;
  } finally {
    // Final cleanup
    if (browser) {
      try {
        await dualLogInfo("Performing final browser cleanup");
        await browser.close();
        await dualLogInfo("Browser closed successfully");
      } catch (cleanupError) {
        await dualLogError("Error during final browser cleanup:", cleanupError);
      }
    }
  }
}

export default agoda;
