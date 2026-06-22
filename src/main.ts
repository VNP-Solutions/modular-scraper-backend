import dotenv from "dotenv";
import { browserSetupLocal } from "./browser-setup/browser-local.js";
import { browserSetupProduction } from "./browser-setup/browser-prod.js";
import { delay } from "./common/delay.js";
import { emailNotifier } from "./common/email-notifier.js";
import { decryptPassword } from "./common/encription.js";
import {
  dualLogError,
  dualLogInfo,
  finalizeJobLogging,
  initializeJobLogging,
} from "./common/log-helper.js";
import { otpCompletionNotifier } from "./common/otp-completion-notifier.js";
import { progressManager } from "./common/progress-manager.js";
import { takeScreenshot } from "./common/screenshot-helper.js";
import { scrapingStateManager } from "./common/scraping-state.js";
import { timeManager } from "./common/time-manager.js";
import { getNextDateFromCompleted } from "./date-split/helper.js";
import login from "./login/login.js";
import { JobStatus } from "./models/job.model.js";
import handleOtpVerification from "./otp-verification/otp-verification.js";
import { propertySearchAndClickReservation } from "./property-search/property-search.js";
import {
  FAILED_REASON,
  isStatusAlreadySaved,
  markStatusSaved,
  setFailedReasonCode,
} from "./common/failed-reason.js";
import {
  getFailedReasonForUser,
  jobService,
} from "./services/job.service.js";
import type { ExpediaBrightDataOptions } from "./common/job-isolation.js";

dotenv.config();

async function main(
  expediaId?: string,
  startDate?: string,
  endDate?: string,
  jobId?: string,
  user_email?: string,
  user_password?: string,
  expediaBrightData?: ExpediaBrightDataOptions
): Promise<void> {
  let jobLogger = null;
  let browser = null;

  // Initialize time management
  await timeManager.startSession(jobId);

  try {
    // Initialize job logging if jobId is provided
    if (jobId) {
      jobLogger = initializeJobLogging(jobId);
      await dualLogInfo(`Starting job ${jobId}`, {
        expediaId,
        startDate,
        endDate,
        user_email: user_email ? "[REDACTED]" : undefined,
        timeSession: timeManager.getSessionInfo(),
      });

      // Check if job should resume from a specific date
      const resumeInfo = progressManager.shouldJobResume(jobId);
      if (resumeInfo.shouldResume && resumeInfo.resumeDate && startDate) {
        const nextStartDate = getNextDateFromCompleted(resumeInfo.resumeDate);
        await dualLogInfo(
          `Job resuming from date: ${nextStartDate} (last completed: ${resumeInfo.resumeDate})`,
          {
            jobId,
            originalStartDate: startDate,
            resumeStartDate: nextStartDate,
            lastProcessedDate: resumeInfo.resumeDate,
          }
        );
        startDate = nextStartDate;
      }
    }

    // const client = new Steel({
    //   steelAPIKey: process.env.STEEL_API_KEY, // Optional
    // });
    // Create a session with additional features
    // const session = await client.sessions.create({
    //   region: "lax",
    //   useProxy: true,
    //   solveCaptcha: true,
    // });
    // const debugUrl = session.debugUrl;
    // console.log(`Debug URL: ${debugUrl}`);
    // console.log(session);
    try {
      // Start the main scraping loop that handles browser restarts
      await runScrapingWithRestart(
        expediaId,
        startDate,
        endDate,
        jobId,
        user_email,
        user_password,
        expediaBrightData
      );

      // End time session on successful completion
      await timeManager.endSession();

      // Finalize logging with success status
      if (jobId) {
        await finalizeJobLogging("success");
      }
    } catch (error) {
      await dualLogError("Main function error:", error);

      // End time session on error
      await timeManager.endSession();

      // Clean up progress file on inner main function error
      if (jobId) {
        await progressManager.handleJobError(jobId, error);
      }

      const failedReason = getFailedReasonForUser(
        error,
        "Scraping failed; no reservations found"
      );

      // Check job items count and set appropriate job status
      if (jobId) {
        try {
          const jobItemsCount = await jobService.getJobItemsCount(jobId);

          if (jobItemsCount > 0) {
            // If job items found, set status to Partial
            await jobService.updateJobStatus(
              jobId,
              JobStatus.Partial,
              failedReason
            );
            await dualLogInfo(
              `Job status set to Partial - found ${jobItemsCount} job items`,
              { jobId, jobItemsCount }
            );
          } else {
            // If no job items found, set status to Failed
            await jobService.updateJobStatus(
              jobId,
              JobStatus.Failed,
              failedReason
            );
            await dualLogInfo("Job status set to Failed - no job items found", {
              jobId,
              jobItemsCount: 0,
            });
          }
        } catch (statusError) {
          await dualLogError(
            "Error updating job status based on job items count:",
            statusError,
            { jobId }
          );
          // Fallback to Failed status if there's an error checking job items
          try {
            await jobService.updateJobStatus(
              jobId,
              JobStatus.Failed,
              failedReason
            );
          } catch (fallbackError) {
            await dualLogError(
              "Error setting fallback Failed status:",
              fallbackError,
              { jobId }
            );
          }
        }
      }

      // Finalize logging with failed status
      if (jobId) {
        await finalizeJobLogging("failed");
      }
      markStatusSaved(error);
      throw error;
    }
  } catch (error) {
    await dualLogError("Main function error:", error);

    // Send email notification for outer main function error
    if (jobId) {
      try {
        await emailNotifier.notifyJobError(
          jobId,
          (error as any)?.message || "Unknown error in outer main function",
          error,
          {
            stage: "outer_main_function",
            progressPercentage:
              progressManager.getJobProgress(jobId)?.progressPercentage,
            lastProcessedDate:
              progressManager.getJobLastProcessedDate(jobId) || undefined,
          }
        );
      } catch (emailError) {
        await dualLogError(
          "Failed to send error notification email:",
          emailError
        );
      }
    }

    // End time session on error
    await timeManager.endSession();

    // Clean up progress file on main function error
    if (jobId) {
      await progressManager.handleJobError(jobId, error);
    }

    // Inner catch already saved the status — skip to avoid overwriting the real failed_reason
    if (!isStatusAlreadySaved(error) && jobId) {
      const failedReason = getFailedReasonForUser(
        error,
        "Scraping failed; no reservations found"
      );

      // Check job items count and set appropriate job status
      try {
        const jobItemsCount = await jobService.getJobItemsCount(jobId);

        if (jobItemsCount > 0) {
          // If job items found, set status to Partial
          await jobService.updateJobStatus(
            jobId,
            JobStatus.Partial,
            failedReason
          );
          await dualLogInfo(
            `Job status set to Partial - found ${jobItemsCount} job items`,
            { jobId, jobItemsCount }
          );
        } else {
          // If no job items found, set status to Failed
          await jobService.updateJobStatus(
            jobId,
            JobStatus.Failed,
            failedReason
          );
          await dualLogInfo("Job status set to Failed - no job items found", {
            jobId,
            jobItemsCount: 0,
          });
        }
      } catch (statusError) {
        await dualLogError(
          "Error updating job status based on job items count:",
          statusError,
          { jobId }
        );
        // Fallback to Failed status if there's an error checking job items
        try {
          await jobService.updateJobStatus(
            jobId,
            JobStatus.Failed,
            failedReason
          );
        } catch (fallbackError) {
          await dualLogError(
            "Error setting fallback Failed status:",
            fallbackError,
            { jobId }
          );
        }
      }
    }

    // Finalize logging with failed status
    if (jobId) {
      await finalizeJobLogging("failed");
    }
    throw error;
  }
}

async function runScrapingWithRestart(
  expediaId?: string,
  startDate?: string,
  endDate?: string,
  jobId?: string,
  user_email?: string,
  user_password?: string,
  expediaBrightData?: ExpediaBrightDataOptions
): Promise<void> {
  const environment = process.env.ENVIRONMENT || "browserless";
  let currentStartDate = startDate;
  let attemptCount = 0;
  const maxAttempts = 100; // Prevent infinite loops

  // Helper function to compare dates in MM/DD/YYYY format
  const compareDates = (date1: string, date2: string): number => {
    const parseDate = (dateStr: string): Date => {
      const [month, day, year] = dateStr.split("/").map(Number);
      return new Date(year, month - 1, day);
    };
    const d1 = parseDate(date1);
    const d2 = parseDate(date2);
    return d1.getTime() - d2.getTime();
  };

  while (
    currentStartDate &&
    endDate &&
    compareDates(currentStartDate, endDate) <= 0 &&
    attemptCount < maxAttempts
  ) {
    attemptCount++;
    let browser = null;
    let page = null;

    try {
      await dualLogInfo(`Starting scraping attempt ${attemptCount}`, {
        currentStartDate,
        endDate,
        jobId,
        timeSession: timeManager.getSessionInfo(),
      });

      // Step 1: Setup browser and navigate to login page
      await dualLogInfo("Setting up browser...");
      let setupResult = null;
      if (environment === "browserless") {
        setupResult = await browserSetupProduction(jobId, "expedia");
      } else {
        setupResult = await browserSetupLocal(
          jobId,
          "expedia",
          expediaBrightData?.brightDataSessionId,
          expediaBrightData?.windowSize,
          expediaBrightData?.timezone,
          expediaBrightData?.acceptLanguage
        );
      }
      browser = setupResult.browser;
      page = setupResult.page;

      await dualLogInfo(
        "Browser setup complete. Page is ready at login screen."
      );

      // Check if scraping is paused and wait if needed
      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        await dualLogInfo("Scraping was stopped, exiting...");
        await browser.close();
        if (jobId) {
          await jobService.updateJobStatus(
            jobId,
            JobStatus.Failed,
            "Scraping was stopped"
          );
          await finalizeJobLogging("failed");
        }
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
            if (jobId) {
              await jobService.updateJobStatus(
                jobId,
                JobStatus.Failed,
                "Scraping was stopped"
              );
              await finalizeJobLogging("failed");
            }
            return;
          }

          await login(browser, page, email, password, jobId);
          await dualLogInfo(
            "Login completed successfully! User is now logged in."
          );

          // Screenshot: login completed
          await takeScreenshot(page, jobId ?? "", "login_complete", "step");

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
            if (jobId) {
              await jobService.updateJobStatus(
                jobId,
                JobStatus.Failed,
                "Scraping was stopped"
              );
              await finalizeJobLogging("failed");
            }
            return;
          }

          await handleOtpVerification(browser, page, jobId);
          await dualLogInfo("OTP verification completed successfully!");

          // Screenshot: OTP verification complete
          await takeScreenshot(page, jobId ?? "", "otp_complete", "step");

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
              if (jobId) {
                await jobService.updateJobStatus(
                  jobId,
                  JobStatus.Failed,
                  "Scraping was stopped"
                );
                await finalizeJobLogging("failed");
              }
              return;
            }

            await dualLogInfo(
              `Starting property search for Expedia ID: ${expediaId}`
            );
            await propertySearchAndClickReservation(
              browser,
              page,
              expediaId,
              jobId
            );
            await dualLogInfo(
              "Property search completed successfully! Property found."
            );
            // Screenshot: property search complete
            await takeScreenshot(
              page,
              jobId ?? "",
              "property_search_complete",
              "step"
            );
          } catch (error: any) {
            await dualLogError("Property search failed:", error);
            throw error;
          }
        } else {
          await dualLogInfo(
            "No expedia ID provided, skipping property search."
          );
          // Close browser when done with this attempt
          if (browser) {
            await browser.close();
            browser = null;
          }
          await dualLogInfo("Browser closed successfully.");
          break; // Exit the retry loop
        }

        // Verification-only flow: login + 2FA succeeded and the property was
        // located. Stop here without processing the date range or scraping any
        // reservation data.
        await dualLogInfo(
          "Login, verification and property search completed. Stopping (verification-only mode)."
        );
        // Close browser when done with this attempt
        if (browser) {
          await browser.close();
          browser = null;
        }
        await dualLogInfo("Browser closed successfully.");
        break; // Exit the retry loop
      } else {
        await dualLogInfo("No login credentials provided.");
        await dualLogInfo("Browser closed successfully.");
        // Close browser when done with this attempt
        if (browser) {
          await browser.close();
        }
        break; // Exit the retry loop
      }
    } catch (error) {
      await dualLogError(`Scraping attempt ${attemptCount} failed:`, error);

      // Screenshot: job failed
      await takeScreenshot(page, jobId ?? "", "job_failed", "error");

      // Notify that OTP work is completed (on error) so other jobs can proceed
      if (jobId) {
        otpCompletionNotifier.notifyOtpCompleted(jobId);
      }

      // Close browser on error
      if (browser) {
        try {
          await browser.close();
        } catch (closeError) {
          await dualLogError("Error closing browser:", closeError);
        }
      }

      // If it's not a browser restart error, clean up progress and propagate
      if (
        !(error instanceof Error) ||
        !error.message.startsWith("BROWSER_RESTART_NEEDED:")
      ) {
        // Clean up progress file on error
        if (jobId) {
          await progressManager.handleJobError(jobId, error);
        }

        const failedReason = getFailedReasonForUser(
          error,
          "Scraping failed; no reservations found"
        );

        // Check job items count and set appropriate job status
        if (jobId) {
          try {
            const jobItemsCount = await jobService.getJobItemsCount(jobId);

            if (jobItemsCount > 0) {
              // If job items found, set status to Partial
              await jobService.updateJobStatus(
                jobId,
                JobStatus.Partial,
                failedReason
              );
              await dualLogInfo(
                `Job status set to Partial - found ${jobItemsCount} job items`,
                { jobId, jobItemsCount }
              );
            } else {
              // If no job items found, set status to Failed
              await jobService.updateJobStatus(
                jobId,
                JobStatus.Failed,
                failedReason
              );
              await dualLogInfo(
                "Job status set to Failed - no job items found",
                {
                  jobId,
                  jobItemsCount: 0,
                }
              );
            }
          } catch (statusError) {
            await dualLogError(
              "Error updating job status based on job items count:",
              statusError,
              { jobId }
            );
            // Fallback to Failed status if there's an error checking job items
            try {
              await jobService.updateJobStatus(
                jobId,
                JobStatus.Failed,
                failedReason
              );
            } catch (fallbackError) {
              await dualLogError(
                "Error setting fallback Failed status:",
                fallbackError,
                { jobId }
              );
            }
          }
        }

        throw error;
      }
    }
  }

  if (attemptCount >= maxAttempts) {
    const maxAttemptsError = new Error(
      `Maximum restart attempts (${maxAttempts}) exceeded`
    );
    setFailedReasonCode(maxAttemptsError, FAILED_REASON.MAX_RESTART_ATTEMPTS);
    const maxAttemptsReason = getFailedReasonForUser(
      maxAttemptsError,
      "Maximum restart attempts exceeded"
    );
    // Clean up progress file when max attempts exceeded
    if (jobId) {
      await progressManager.handleJobError(jobId, maxAttemptsError);
    }

    // Check job items count and set appropriate job status for max attempts error
    if (jobId) {
      try {
        const jobItemsCount = await jobService.getJobItemsCount(jobId);

        if (jobItemsCount > 0) {
          // If job items found, set status to Partial
          await jobService.updateJobStatus(
            jobId,
            JobStatus.Partial,
            maxAttemptsReason
          );
          await dualLogInfo(
            `Job status set to Partial - found ${jobItemsCount} job items (max attempts exceeded)`,
            { jobId, jobItemsCount, maxAttempts }
          );
        } else {
          // If no job items found, set status to Failed
          await jobService.updateJobStatus(
            jobId,
            JobStatus.Failed,
            maxAttemptsReason
          );
          await dualLogInfo(
            "Job status set to Failed - no job items found (max attempts exceeded)",
            {
              jobId,
              jobItemsCount: 0,
              maxAttempts,
            }
          );
        }
      } catch (statusError) {
        await dualLogError(
          "Error updating job status based on job items count:",
          statusError,
          { jobId }
        );
        // Fallback to Failed status if there's an error checking job items
        try {
          await jobService.updateJobStatus(
            jobId,
            JobStatus.Failed,
            maxAttemptsReason
          );
        } catch (fallbackError) {
          await dualLogError(
            "Error setting fallback Failed status:",
            fallbackError,
            { jobId }
          );
        }
      }
    }

    throw maxAttemptsError;
  }

  await dualLogInfo("Scraping completed successfully!", {
    totalAttempts: attemptCount,
    jobId,
  });
}

export default main;
