/**
 * Agoda "reopen with all reservations" run.
 *
 * Mirrors the property run (browser setup → login → property page → Need Help)
 * but skips the date-range booking lookup entirely: instead of scraping
 * reservations again, it re-attaches the same CSV a previous completed run
 * already filed with Need Help (`job.need_help_file_url`), downloaded fresh
 * from S3 for this attempt.
 */

import dotenv from "dotenv";
import { Browser, Page } from "puppeteer";
import { browserSetupLocal } from "../../browser-setup/browser-local.js";
import { browserSetupProduction } from "../../browser-setup/browser-prod.js";
import { emailNotifier } from "../../common/email-notifier.js";
import {
  FAILED_REASON,
  setFailedReasonCode,
} from "../../common/failed-reason.js";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { downloadNeedHelpFileFromUrl } from "../../common/need-help-file.js";
import { otpCompletionNotifier } from "../../common/otp-completion-notifier.js";
import { progressManager } from "../../common/progress-manager.js";
import { scrapingStateManager } from "../../common/scraping-state.js";
import {
  takeErrorScreenshot,
  takeSuccessScreenshot,
} from "../../common/screenshot-helper.js";
import { timeManager } from "../../common/time-manager.js";
import { jobService } from "../../services/job.service.js";
import agodaLogin from "../login-system/login.js";
import { automateNeedHelpWithCleanup } from "../need-help/need-help.js";
import { cleanupOnError } from "../utils/error-cleanup.js";
import {
  ensureDirectoryExists,
  getStandardFilePaths,
} from "../utils/file-naming.js";
import { openPropertyPage } from "./reopen-case.js";

dotenv.config();

export interface ReopenAllReservationsParams {
  agodaId: string;
  jobId: string;
  agodaUsername: string;
  agodaPassword: string;
  /** S3 URL of the CSV a previous completed run filed with Need Help. */
  needHelpFileUrl: string;
  /**
   * The job's own date range (same format bulk-property-run uses). Included
   * in the property page URL so it matches what a property run would have
   * opened — no booking data is fetched either way.
   */
  startDate?: string;
  endDate?: string;
  brightDataSessionId?: string;
  windowSize?: { width: number; height: number };
  timezone?: string;
  acceptLanguage?: string;
}

export interface ReopenAllReservationsResult {
  jobId: string;
  agodaId: string;
}

/**
 * Logs in, opens the property page and re-files Need Help using the file
 * archived from an earlier completed run — no reservation re-scrape.
 */
export async function runAgodaReopenAllReservations(
  params: ReopenAllReservationsParams
): Promise<ReopenAllReservationsResult> {
  const {
    agodaId,
    jobId,
    agodaUsername,
    agodaPassword,
    needHelpFileUrl,
    startDate,
    endDate,
    brightDataSessionId,
    windowSize,
    timezone,
    acceptLanguage,
  } = params;

  let browser: Browser | null = null;
  let propertyPage: Page | null = null;

  await timeManager.startSession(jobId);

  try {
    await dualLogInfo("Starting Agoda reopen-all-reservations process", {
      jobId,
      agodaId,
      needHelpFileUrl,
      timeSession: timeManager.getSessionInfo(),
    });

    if (!agodaUsername || !agodaPassword) {
      throw new Error("Agoda username or password is not set");
    }

    if (!agodaId) {
      throw new Error("agodaId is a required parameter");
    }

    if (!needHelpFileUrl) {
      throw new Error(
        "need_help_file_url is missing for this job — nothing to re-attach"
      );
    }

    // No date range here, so progress is tracked as a single stage keyed on
    // today's date purely to keep the progress file valid.
    const today = new Date().toISOString().split("T")[0];
    await progressManager.initializeJobProgress(jobId, today, today, 1);

    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      const stoppedErr = new Error(
        "Scraping was stopped during Agoda reopen-all-reservations startup"
      );
      setFailedReasonCode(stoppedErr, FAILED_REASON.AGODA_SCRAPING_STOPPED);
      throw stoppedErr;
    }

    await progressManager.updateJobProgress(
      jobId,
      undefined,
      5,
      "agoda_reopen_all_reservations_initialized",
      undefined
    );

    // Download the previously archived file up front — no point opening a
    // browser if there is nothing to re-attach.
    const { exportFilePath, exportDir } = getStandardFilePaths(jobId);
    ensureDirectoryExists(exportDir);
    await downloadNeedHelpFileFromUrl(jobId, needHelpFileUrl, exportFilePath);

    await progressManager.updateJobProgress(
      jobId,
      undefined,
      15,
      "agoda_reopen_all_reservations_file_downloaded",
      undefined
    );

    const environment = process.env.ENVIRONMENT || "production";
    await dualLogInfo(`Setting up browser for ${environment} environment`, {
      jobId,
      brightDataSessionId,
      windowSize,
      timezone,
      acceptLanguage,
    });

    const setupResult =
      environment === "production"
        ? await browserSetupProduction(jobId, "agoda")
        : await browserSetupLocal(
            jobId,
            "agoda",
            brightDataSessionId,
            windowSize,
            timezone,
            acceptLanguage
          );

    browser = setupResult.browser;
    const loginPage = setupResult.page;
    await dualLogInfo("Browser setup completed successfully", { jobId });

    if (loginPage) {
      await takeSuccessScreenshot(loginPage, jobId, "browser_setup_completed");
    }

    await progressManager.updateJobProgress(
      jobId,
      undefined,
      30,
      "agoda_reopen_all_reservations_browser_setup_complete",
      undefined
    );

    await agodaLogin(browser, loginPage, agodaUsername, agodaPassword, jobId);
    await dualLogInfo("Agoda login completed successfully", { jobId });

    if (loginPage) {
      await takeSuccessScreenshot(loginPage, jobId, "login_completed");
    }

    await progressManager.updateJobProgress(
      jobId,
      undefined,
      50,
      "agoda_reopen_all_reservations_login_complete",
      undefined
    );

    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      const stoppedErr = new Error(
        "Scraping was stopped before the Agoda property page could be opened"
      );
      setFailedReasonCode(stoppedErr, FAILED_REASON.AGODA_SCRAPING_STOPPED);
      throw stoppedErr;
    }

    // Same page a property run would open, date range included when known —
    // still no booking data fetch, Need Help only needs the portal loaded.
    propertyPage = await openPropertyPage(
      browser,
      agodaId,
      jobId,
      startDate,
      endDate
    );

    await progressManager.updateJobProgress(
      jobId,
      undefined,
      70,
      "agoda_reopen_all_reservations_property_page_loaded",
      undefined
    );

    const job = await jobService.getJobById(jobId);

    await dualLogInfo(
      "Starting Need Help automation re-attaching the archived file",
      { jobId, agodaId, exportFilePath }
    );

    // Same call the property run makes after a fresh CSV export — default
    // message, cleanup afterwards. The only difference is the file already
    // exists on disk (downloaded above) instead of being freshly exported.
    await automateNeedHelpWithCleanup(propertyPage, {
      jobId,
      agodaId,
      propertyName: job?.property_name,
      cleanupAfter: true,
    });

    await progressManager.markJobCompleted(jobId);
    await timeManager.endSession();

    await dualLogInfo(
      "Agoda reopen-all-reservations process completed successfully",
      {
        jobId,
        agodaId,
        timeSession: timeManager.getSessionInfo(),
      }
    );

    return { jobId, agodaId };
  } catch (error: any) {
    await dualLogError("Error in Agoda reopen-all-reservations:", error, {
      jobId,
    });

    if (browser) {
      try {
        const pages = await browser.pages();
        const activePage = pages.find((p) => !p.isClosed()) || pages[0];
        if (activePage) {
          await takeErrorScreenshot(
            activePage,
            jobId,
            "reopen_all_reservations_error"
          );
        }
      } catch (screenshotError) {
        await dualLogError(
          "Failed to take error screenshot:",
          screenshotError,
          { jobId }
        );
      }
    }

    // Release the OTP slot so queued jobs can move on.
    otpCompletionNotifier.notifyOtpCompleted(jobId);

    await timeManager.endSession();
    await progressManager.handleJobError(jobId, error);

    try {
      const cleanupResult = await cleanupOnError(jobId, {
        agodaId,
        operation: "agoda_reopen_all_reservations_error",
      });
      await dualLogInfo("Standardized cleanup completed", {
        jobId,
        totalFilesProcessed: cleanupResult.totalFilesProcessed,
        errors: cleanupResult.errors.length,
      });
    } catch (cleanupError: any) {
      await dualLogError(
        "Error during standardized cleanup (continuing with error handling):",
        cleanupError.message,
        { jobId }
      );
    }

    try {
      await emailNotifier.notifyJobError(
        jobId,
        error?.message || "Unknown error in Agoda reopen-all-reservations",
        error,
        {
          stage: "agoda_reopen_all_reservations",
          progressPercentage:
            progressManager.getJobProgress(jobId)?.progressPercentage,
        }
      );
    } catch (emailError) {
      await dualLogError(
        "Failed to send error notification email:",
        emailError,
        { jobId }
      );
    }

    throw error;
  } finally {
    if (browser) {
      try {
        await browser.close();
        await dualLogInfo("Browser closed successfully", { jobId });
      } catch (cleanupError) {
        await dualLogError(
          "Error during final browser cleanup:",
          cleanupError,
          { jobId }
        );
      }
    }
  }
}

export default runAgodaReopenAllReservations;
