import dotenv from "dotenv";
import { Browser } from "puppeteer";
import { useRemoteBrowser } from "./config/index.js";
import agodaLogin from "./agoda/login-system/login.js";
import { searchAgodaProperty } from "./agoda/property-search/property-search.js";
import { browserSetupLocal } from "./browser-setup/browser-local.js";
import { browserSetupProduction } from "./browser-setup/browser-prod.js";
import {
  FAILED_REASON,
  getFailedReasonForUser,
  isStatusAlreadySaved,
  markStatusSaved,
  setFailedReasonCode,
} from "./common/failed-reason.js";
import { dualLogError, dualLogInfo } from "./common/log-helper.js";
import { otpCompletionNotifier } from "./common/otp-completion-notifier.js";
import { progressManager } from "./common/progress-manager.js";
import { scrapingStateManager } from "./common/scraping-state.js";
import {
  takeErrorScreenshot,
  takeSuccessScreenshot,
} from "./common/screenshot-helper.js";
import { timeManager } from "./common/time-manager.js";
import { JobStatus } from "./models/job.model.js";
import { jobService } from "./services/job.service.js";

dotenv.config();

export interface AgodaPropertyCheckResult {
  agodaId: string;
  propertyFound: boolean;
}

async function agoda(
  agodaId?: string,
  startDate?: string,
  endDate?: string,
  jobId?: string,
  agodaUsername?: string,
  agodaPassword?: string,
  brightDataSessionId?: string,
  windowSize?: { width: number; height: number },
  timezone?: string,
  acceptLanguage?: string
): Promise<AgodaPropertyCheckResult> {
  let browser: Browser | null = null;

  await timeManager.startSession(jobId);

  try {
    await dualLogInfo("Starting Agoda property check (login + property search)", {
      agodaId,
      startDate,
      endDate,
      jobId,
    });

    if (!agodaUsername || !agodaPassword) {
      throw new Error("Agoda username or password is not set");
    }

    if (!agodaId || !startDate || !endDate) {
      throw new Error(
        "agodaId, startDate, and endDate are required parameters"
      );
    }

    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      const stoppedErr = new Error(
        "Scraping was stopped during Agoda automation startup"
      );
      setFailedReasonCode(stoppedErr, FAILED_REASON.AGODA_SCRAPING_STOPPED);
      throw stoppedErr;
    }

    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        10,
        "agoda_browser_setup",
        undefined
      );
    }

    const setupResult = useRemoteBrowser()
      ? await browserSetupProduction(jobId)
      : await browserSetupLocal(
          jobId,
          brightDataSessionId,
          windowSize,
          timezone,
          acceptLanguage
        );

    browser = setupResult.browser;
    const page = setupResult.page;
    await dualLogInfo("Browser setup completed");

    if (jobId && page) {
      await takeSuccessScreenshot(page, jobId, "browser_setup_completed");
    }

    // --- Step 1: Login ---
    try {
      await agodaLogin(browser, page, agodaUsername, agodaPassword, jobId);
      await dualLogInfo("Agoda login completed successfully");

      if (jobId && page) {
        await takeSuccessScreenshot(page, jobId, "login_completed");
      }

      if (jobId) {
        await progressManager.updateJobProgress(
          jobId,
          undefined,
          50,
          "agoda_login_complete",
          undefined
        );
      }
    } catch (loginError: any) {
      await dualLogError("Login failed:", loginError);

      // TODO: Implement logic for failed job here (e.g. update job status, notify, retry)

      throw loginError;
    }

    // --- Step 2: Property search ---
    const searchResult = await searchAgodaProperty(
      browser,
      page,
      agodaId,
      startDate,
      endDate,
      jobId
    );

    if (!searchResult.found) {
      await dualLogInfo(`Property not found for agodaId: ${agodaId}`, {
        jobId,
        agodaId,
      });

      // TODO: Implement logic when property not found here (e.g. mark job failed, set reason)

      if (jobId) {
        await progressManager.updateJobProgress(
          jobId,
          undefined,
          100,
          "agoda_property_not_found",
          undefined
        );
      }

      return { agodaId, propertyFound: false };
    }

    // Property found — flow completed successfully
    await dualLogInfo(`Property found for agodaId: ${agodaId}`, {
      jobId,
      agodaId,
    });

    if (jobId) {
      await progressManager.markJobCompleted(jobId);
    }

    await timeManager.endSession();

    if (jobId && page) {
      await takeSuccessScreenshot(page, jobId, "property_check_completed");
    }

    return { agodaId, propertyFound: true };
  } catch (error: any) {
    await dualLogError("Error in Agoda property check:", error);

    if (jobId && browser) {
      try {
        const pages = await browser.pages();
        const activePage = pages.find((p) => !p.isClosed()) || pages[0];
        if (activePage) {
          await takeErrorScreenshot(
            activePage,
            jobId,
            "agoda_property_check_error"
          );
        }
      } catch (screenshotError) {
        await dualLogError("Failed to take error screenshot:", screenshotError);
      }
    }

    if (jobId) {
      otpCompletionNotifier.notifyOtpCompleted(jobId);
    }

    await timeManager.endSession();

    if (jobId) {
      await progressManager.handleJobError(jobId, error);
    }

    if (jobId && !isStatusAlreadySaved(error)) {
      const failedReason =
        getFailedReasonForUser(error) ||
        "An unexpected error occurred. Please try again.";
      const currentJob = await jobService.getJobById(jobId);
      if (currentJob) {
        await jobService.updateJobStatusWithReason(
          jobId,
          JobStatus.Failed,
          failedReason
        );
      }
      markStatusSaved(error);
    }

    throw error;
  } finally {
    if (browser) {
      try {
        await browser.close();
        await dualLogInfo("Browser closed successfully");
      } catch (cleanupError) {
        await dualLogError("Error closing browser:", cleanupError);
      }
    }
  }
}

export default agoda;
