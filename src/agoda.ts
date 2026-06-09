import dotenv from "dotenv";
import { Browser } from "puppeteer";
import { getAgodaBookingData } from "./agoda/booking-data/booking-data.js";
import agodaLogin from "./agoda/login-system/login.js";
import { cleanupOnError } from "./agoda/utils/error-cleanup.js";
import { browserSetupLocal } from "./browser-setup/browser-local.js";
import { browserSetupProduction } from "./browser-setup/browser-prod.js";
import {
  FAILED_REASON,
  getFailedReasonForUser,
  isStatusAlreadySaved,
  markStatusSaved,
  setFailedReasonCode,
} from "./common/failed-reason.js";
import { emailNotifier } from "./common/email-notifier.js";
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

async function agoda(
  agodaId?: string,
  startDate?: string,
  endDate?: string,
  jobId?: string,
  agodaUsername?: string,
  agodaPassword?: string,
  brightDataSessionId?: string,
  windowSize?: { width: number; height: number },
  timezone?: string, // Added for timezone spoofing
  acceptLanguage?: string // Added for Accept-Language header
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

    // Set case_open to false at the start of scraping
    if (jobId) {
      try {
        await jobService.updateJobCaseOpen(jobId, false);
        await dualLogInfo(
          `Set case_open to false for job ${jobId} at start of scraping`,
          {
            jobId,
            timeSession: timeManager.getSessionInfo(),
          }
        );
      } catch (caseOpenError: any) {
        await dualLogError(
          `Warning: Failed to set case_open to false for job ${jobId}:`,
          caseOpenError.message,
          { jobId }
        );
        // Don't throw error - this shouldn't fail the job
      }
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
      const stoppedErr = new Error(
        "Scraping was stopped during Agoda automation startup"
      );
      setFailedReasonCode(stoppedErr, FAILED_REASON.AGODA_SCRAPING_STOPPED);
      throw stoppedErr;
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
    await dualLogInfo(`Setting up browser for ${environment} environment`, {
      brightDataSessionId,
      windowSize,
      timezone,
      acceptLanguage,
    });

    let setupResult = null;
    if (environment === "production") {
      setupResult = await browserSetupProduction(jobId, "agoda");
    } else {
      // Use local browser with Bright Data proxy
      setupResult = await browserSetupLocal(
        jobId,
        "agoda",
        brightDataSessionId,
        windowSize,
        timezone,
        acceptLanguage
      );
    }

    browser = setupResult.browser;
    const page = setupResult.page;
    await dualLogInfo("Browser setup completed successfully");

    // Take screenshot after successful browser setup
    if (jobId && page) {
      await takeSuccessScreenshot(page, jobId, "browser_setup_completed");
    }

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

    // Agoda login process (which includes OTP verification)
    await agodaLogin(browser, page, agodaUsername, agodaPassword, jobId);
    await dualLogInfo("Agoda login completed successfully");

    // Take screenshot after successful login
    if (jobId && page) {
      await takeSuccessScreenshot(page, jobId, "login_completed");
    }

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

    // Take screenshot after successful booking data retrieval
    if (jobId && page) {
      await takeSuccessScreenshot(page, jobId, "booking_data_completed");
    }

    // Mark job as completed
    if (jobId) {
      await progressManager.markJobCompleted(jobId);
    }

    // Standardized cleanup on successful completion
    try {
      await dualLogInfo(
        "Starting standardized cleanup after successful completion",
        {
          jobId,
          agodaId,
          recordCount: bookingData.length,
          timeSession: timeManager.getSessionInfo(),
        }
      );

      const cleanupResult = await cleanupOnError(jobId, {
        agodaId,
        operation: "agoda_automation_success_cleanup",
      });

      await dualLogInfo(
        "Standardized cleanup completed after successful completion",
        {
          jobId,
          downloadFilesCleanedCount: cleanupResult.downloadFilesCleanedCount,
          exportFilesCleanedCount: cleanupResult.exportFilesCleanedCount,
          foldersRemovedCount: cleanupResult.foldersRemovedCount,
          totalFilesProcessed: cleanupResult.totalFilesProcessed,
          errors: cleanupResult.errors.length,
          timeSession: timeManager.getSessionInfo(),
        }
      );
    } catch (cleanupError: any) {
      await dualLogError(
        "Error during standardized cleanup after successful completion (continuing):",
        cleanupError.message,
        { jobId }
      );
      // Don't throw cleanup error - continue with successful completion
    }

    // End time session on successful completion
    await timeManager.endSession();

    // Take final success screenshot
    if (jobId && page) {
      await takeSuccessScreenshot(page, jobId, "job_completed_successfully");
    }

    await dualLogInfo("Agoda automation process completed successfully", {
      recordCount: bookingData.length,
      jobId,
      timeSession: timeManager.getSessionInfo(),
    });
    return bookingData;
  } catch (error: any) {
    await dualLogError("Error in Agoda automation:", error);

    // Take error screenshot when error occurs
    if (jobId && browser) {
      try {
        const pages = await browser.pages();
        const activePage = pages.find((p) => !p.isClosed()) || pages[0];
        if (activePage) {
          await takeErrorScreenshot(
            activePage,
            jobId,
            "agoda_automation_error"
          );
        }
      } catch (screenshotError) {
        await dualLogError("Failed to take error screenshot:", screenshotError);
      }
    }

    // Notify that OTP work is completed (on error) so other jobs can proceed
    if (jobId) {
      otpCompletionNotifier.notifyOtpCompleted(jobId);
    }

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

    // Standardized cleanup on error
    try {
      await dualLogInfo(
        "Starting standardized cleanup due to Agoda automation error",
        {
          jobId,
          agodaId,
          timeSession: timeManager.getSessionInfo(),
        }
      );

      const cleanupResult = await cleanupOnError(jobId, {
        agodaId,
        operation: "agoda_automation_error",
      });

      await dualLogInfo("Standardized cleanup completed", {
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

    // Send email notification for outer main function error
    if (jobId) {
      // Make the job fail, preserving any failed_reason already set by inner catches
      if (!isStatusAlreadySaved(error)) {
        const failedReason =
          getFailedReasonForUser(error) ||
          "An unexpected error occurred. Please try again.";
        const CurrentJob = await jobService.getJobById(jobId);
        if (CurrentJob) {
          await jobService.updateJobStatusWithReason(
            jobId,
            JobStatus.Failed,
            failedReason
          );
        }
        markStatusSaved(error);
      }
      try {
        await emailNotifier.notifyJobError(
          jobId,
          error?.message || "Unknown error in outer main function",
          error,
          {
            stage: "outer_main_function",
            progressPercentage:
              progressManager.getJobProgress(jobId)?.progressPercentage,
          }
        );
      } catch (emailError) {
        await dualLogError(
          "Failed to send error notification email:",
          emailError
        );
      }
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
