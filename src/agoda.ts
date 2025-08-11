import dotenv from "dotenv";
import { Browser } from "puppeteer";
import agodaLogin from "./agoda/login-system/login.js";
import { getAgodaBookingData } from "./agoda/booking-data/booking-data.js";
import { browserSetupLocal } from "./browser-setup/browser-local.js";
import { browserSetupProduction } from "./browser-setup/browser-prod.js";
import { dualLogError, dualLogInfo } from "./common/log-helper.js";
import { progressManager } from "./common/progress-manager.js";
import { timeManager } from "./common/time-manager.js";
import { scrapingStateManager } from "./common/scraping-state.js";

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

  // Initialize time management session
  await timeManager.startSession(jobId);

  try {
    await dualLogInfo("Starting Agoda automation process", {
      agodaId,
      startDate,
      endDate,
      jobId,
      timeSession: timeManager.getSessionInfo(),
    });

    // Initialize job progress tracking if jobId is provided
    if (jobId && startDate && endDate) {
      await progressManager.initializeJobProgress(
        jobId,
        startDate,
        endDate,
        1 // Single chunk for Agoda (no date splitting like Expedia)
      );
    }

    // Validate credentials and required parameters first
    if (!agodaUsername || !agodaPassword) {
      throw new Error("Agoda username or password is not set");
    }

    if (!agodaId || !startDate || !endDate) {
      throw new Error(
        "agodaId, startDate, and endDate are required parameters"
      );
    }

    // Check if scraping is paused before starting
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogError(
        "Scraping was stopped during Agoda automation startup"
      );
      throw new Error("Scraping was stopped during Agoda automation startup");
    }

    // Update progress - initialization phase
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        5,
        "agoda_automation_initialized",
        undefined
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

    // Update progress - browser setup complete
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        15,
        "agoda_browser_setup_complete",
        undefined
      );
    }

    // Log time session info before login
    await dualLogInfo("Time session info before login", {
      timeSession: timeManager.getSessionInfo(),
      jobId,
    });

    // Agoda login process
    await agodaLogin(browser, page, agodaUsername, agodaPassword, jobId);
    await dualLogInfo("Agoda login completed successfully");

    // Update progress - login complete
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        25,
        "agoda_login_complete",
        undefined
      );
    }

    // Log time session info before booking data retrieval
    await dualLogInfo("Time session info before booking data retrieval", {
      timeSession: timeManager.getSessionInfo(),
      jobId,
    });

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

    // Mark job as completed
    if (jobId) {
      await progressManager.markJobCompleted(jobId);
    }

    // End time session on successful completion
    await timeManager.endSession();

    await dualLogInfo("Agoda automation process completed successfully", {
      recordCount: bookingData.length,
      jobId,
      timeSession: timeManager.getSessionInfo(),
    });
    return bookingData;
  } catch (error: any) {
    await dualLogError("Error in Agoda automation:", error);

    // End time session on error
    await timeManager.endSession();

    // Handle job error and cleanup progress
    if (jobId) {
      await progressManager.handleJobError(jobId, error);
    }

    // Log error details with time session info
    await dualLogInfo("Error occurred in Agoda automation", {
      jobId,
      error: error.message,
      timeSession: timeManager.getSessionInfo(),
    });

    // Send ONE email notification per job failure
    if (jobId) {
      // Email notification logic would go here
    }

    throw error;
  } finally {
    // Final cleanup
    if (browser) {
      try {
        await browser.close();
        await dualLogInfo("Browser closed successfully");
      } catch (cleanupError) {
        await dualLogError("Error during final browser cleanup:", cleanupError);
      }
    }
  }
}

export default agoda;
