import dotenv from "dotenv";
import { Browser } from "puppeteer";
import { getAgodaRetrivealData } from "./agoda/booking-data/booking-retriveal-data.js";
import agodaLogin from "./agoda/login-system/login.js";
import {
  CONFIG,
  PROGRESS_STATUS,
  SCREENSHOT_NAMES,
} from "./agoda/utils/selectors.js";
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
import { progressManager } from "./common/progress-manager.js";
import { scrapingStateManager } from "./common/scraping-state.js";
import { takeScreenshot } from "./common/screenshot-helper.js";
import { timeManager } from "./common/time-manager.js";
import { JobStatus } from "./models/job.model.js";
import { jobService } from "./services/job.service.js";
import { retrievalService } from "./services/retriveal-job.service.js";

dotenv.config();

// Interface for reservation data
interface Reservation {
  id: string;
  idList: string[];
}

let currentRetrievalContext: {
  retrievalId: string;
  parentRetrievalId: string;
  jobId: string; // Add jobId to context
  otpReleased: boolean; // Track if OTP has been released for this retrieval job
} | null = null;

export function setAgodaRetrievalContext(
  retrievalId: string,
  parentRetrievalId: string,
  jobId: string
) {
  currentRetrievalContext = {
    retrievalId,
    parentRetrievalId,
    jobId,
    otpReleased: false,
  };
}

export function clearAgodaRetrievalContext() {
  currentRetrievalContext = null;
}

/**
 * Check if we're currently in a retrieval job context
 */
export function isRetrievalJob(): boolean {
  return currentRetrievalContext !== null;
}

/**
 * Get the current retrieval job ID if in retrieval context
 */
export function getRetrievalJobId(): string | null {
  return currentRetrievalContext?.jobId || null;
}

/**
 * Mark OTP as released for the current retrieval job
 * Returns true if OTP was released (first time), false if already released
 */
export function markOtpReleasedForRetrieval(): boolean {
  if (currentRetrievalContext && !currentRetrievalContext.otpReleased) {
    currentRetrievalContext.otpReleased = true;
    return true;
  }
  return false;
}

/**
 * Check if OTP has already been released for the current retrieval job
 */
export function isOtpReleasedForRetrieval(): boolean {
  return currentRetrievalContext?.otpReleased || false;
}

async function agodaRetrieval(
  agodaId?: string,
  jobId?: string,
  agodaUsername?: string,
  agodaPassword?: string,
  reservations?: Reservation[],
  retrievalId?: string,
  brightDataSessionId?: string,
  windowSize?: { width: number; height: number }
): Promise<any[]> {
  let browser: Browser | null = null;

  // Initialize time management session
  await timeManager.startSession(jobId);

  try {
    await dualLogInfo("Starting Agoda automation process", {
      agodaId,
      jobId,
      timeSession: timeManager.getSessionInfo(),
    });

    // Initialize job progress tracking if jobId is provided
    if (jobId) {
      await progressManager.initializeJobProgressForAgodaRetriveal(jobId, 1);
    }

    // Validate credentials and required parameters first
    if (!agodaUsername || !agodaPassword) {
      const credentialsErr = new Error("Agoda username or password is not set");
      setFailedReasonCode(credentialsErr, FAILED_REASON.AGODA_CREDENTIALS_NOT_SET);
      throw credentialsErr;
    }

    if (!agodaId) {
      throw new Error("agodaId is required");
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

    // // Update progress - initialization phase
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        5,
        PROGRESS_STATUS.AUTOMATION_INITIALIZED,
        undefined
      );
    }

    // Browser setup
    const environment = process.env.ENVIRONMENT || CONFIG.ENVIRONMENT.DEFAULT;
    await dualLogInfo(`Setting up browser for ${environment} environment`, {
      brightDataSessionId,
      windowSize,
    });

    let setupResult = null;
    if (environment === CONFIG.ENVIRONMENT.PRODUCTION) {
      setupResult = await browserSetupProduction(
        jobId,
        CONFIG.OTA_PROVIDER.AGODA
      );
    } else {
      // Use local browser with Bright Data proxy
      setupResult = await browserSetupLocal(
        jobId,
        CONFIG.OTA_PROVIDER.AGODA,
        brightDataSessionId,
        windowSize
      );
    }

    browser = setupResult.browser;
    const page = setupResult.page;
    await dualLogInfo("Browser setup completed successfully");

    // Take screenshot after successful browser setup
    if (page) {
      await takeScreenshot(
        page,
        retrievalId ?? jobId ?? "",
        SCREENSHOT_NAMES.BROWSER_SETUP_COMPLETED,
        "step",
        "agoda",
        retrievalId ? "retrieval" : "job"
      );
    }

    // Update progress - browser setup complete
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        15,
        PROGRESS_STATUS.BROWSER_SETUP_COMPLETE,
        undefined
      );
    }

    // Log time session info before login
    await dualLogInfo("Time session info before login", {
      timeSession: timeManager.getSessionInfo(),
      jobId,
    });

    // Agoda login process (which includes OTP verification)
    await agodaLogin(browser, page, agodaUsername, agodaPassword, jobId, retrievalId ?? jobId, retrievalId ? "retrieval" : "job");
    await dualLogInfo("Agoda login completed successfully");

    // Take screenshot after successful login
    if (page) {
      await takeScreenshot(
        page,
        retrievalId ?? jobId ?? "",
        SCREENSHOT_NAMES.LOGIN_COMPLETED,
        "step",
        "agoda",
        retrievalId ? "retrieval" : "job"
      );
    }

    // Update progress - login complete
    if (jobId) {
      await progressManager.updateJobProgress(
        jobId,
        undefined,
        25,
        PROGRESS_STATUS.LOGIN_COMPLETE,
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

    const bookingData = await getAgodaRetrivealData(
      browser,
      page,
      agodaId,
      jobId,
      reservations,
      agodaUsername,
      retrievalId
    );

    // Take screenshot after successful booking data retrieval
    if (page) {
      await takeScreenshot(
        page,
        retrievalId ?? jobId ?? "",
        SCREENSHOT_NAMES.BOOKING_DATA_COMPLETED,
        "step",
        "agoda",
        retrievalId ? "retrieval" : "job"
      );
    }

    // Validate that card info was actually retrieved before marking as completed
    if (retrievalId) {
      await dualLogInfo("Validating card info retrieval...", { jobId, retrievalId });
      
      const cardInfoStatus = await retrievalService.hasAnyCardInfo(retrievalId);
      
      await dualLogInfo("Card info validation result:", {
        jobId,
        retrievalId,
        totalBookings: cardInfoStatus.totalBookings,
        bookingsWithCardInfo: cardInfoStatus.bookingsWithCardInfo,
        hasCardInfo: cardInfoStatus.hasCardInfo
      });

      // If no card info was retrieved, fail the job
      if (!cardInfoStatus.hasCardInfo) {
        const err = new Error(
          `Failed to retrieve card info. 0 out of ${cardInfoStatus.totalBookings || reservations?.length || 0} bookings have card information.`
        );
        setFailedReasonCode(err, FAILED_REASON.AGODA_CARD_INFO_NOT_FOUND);
        throw err;
      }

      await dualLogInfo(
        `✅ Card info validation passed: ${cardInfoStatus.bookingsWithCardInfo}/${cardInfoStatus.totalBookings} bookings have card info`,
        { jobId, retrievalId }
      );
    }

    // Mark job as completed (only if card info validation passed)
    if (jobId) {
      await progressManager.markJobCompleted(jobId);
    }

    // End time session on successful completion
    await timeManager.endSession();

    // Take final success screenshot
    if (page) {
      await takeScreenshot(
        page,
        retrievalId ?? jobId ?? "",
        SCREENSHOT_NAMES.JOB_COMPLETED_SUCCESSFULLY,
        "step",
        "agoda",
        retrievalId ? "retrieval" : "job"
      );
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
    if (browser) {
      try {
        const pages = await browser.pages();
        const activePage = pages.find((p) => !p.isClosed()) || pages[0];
        if (activePage) {
          await takeScreenshot(
            activePage,
            retrievalId ?? jobId ?? "",
            SCREENSHOT_NAMES.AGODA_AUTOMATION_ERROR,
            "error",
            "agoda",
            retrievalId ? "retrieval" : "job"
          );
        }
      } catch (screenshotError) {
        await dualLogError("Failed to take error screenshot:", screenshotError);
      }
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

    // Send email notification for outer main function error
    if (jobId) {
      // Save failed_reason to the retrieval document (not a job document —
      // retrievalId and jobId are the same value for retrieval runs).
      if (!isStatusAlreadySaved(error)) {
        const failedReason =
          getFailedReasonForUser(error) ||
          "An unexpected error occurred. Please try again.";
        // For retrieval jobs, save to the retrieval document directly
        if (retrievalId) {
          await retrievalService.updateRetrievalStatusWithReason(
            retrievalId,
            "Failed",
            failedReason
          );
          markStatusSaved(error);
        } else {
          // Fallback: try as a regular job (non-retrieval path)
          const CurrentJob = await jobService.getJobById(jobId);
          if (CurrentJob) {
            await jobService.updateJobStatusWithReason(
              jobId,
              JobStatus.Failed,
              failedReason
            );
            markStatusSaved(error);
          }
        }
      }
      try {
        await emailNotifier.notifyJobError(
          jobId,
          error?.message || "Unknown error in outer main function",
          error,
          {
            stage: CONFIG.ERROR_STAGE.OUTER_MAIN_FUNCTION,
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

export default agodaRetrieval;
