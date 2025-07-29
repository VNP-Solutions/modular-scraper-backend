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
import { progressManager } from "./common/progress-manager.js";
import { scrapingStateManager } from "./common/scraping-state.js";
import { timeManager } from "./common/time-manager.js";
import { splitDateRange } from "./date-split/date-split.js";
import { getNextDateFromCompleted } from "./date-split/helper.js";
import login from "./login/login.js";
import handleOtpVerification from "./otp-verification/otp-verification.js";
import { propertySearchAndClickReservation } from "./property-search/property-search.js";
import { jobQueueUrlService } from "./services/job-queue-url.service.js";

dotenv.config();

async function main(
  expediaId?: string,
  startDate?: string,
  endDate?: string,
  jobId?: string,
  user_email?: string,
  user_password?: string
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
        user_password
      );

      // End time session on successful completion
      await timeManager.endSession();

      // Finalize logging with success status
      if (jobId) {
        await finalizeJobLogging("success");
      }
    } catch (error: any) {
      await dualLogError("Main function error:", error);

      // Send email notification for job error
      if (jobId) {
        try {
          await emailNotifier.notifyJobError(
            jobId,
            error?.message || "Unknown error in main function",
            error,
            {
              stage: "main_function",
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

      // Clean up progress file on inner main function error
      if (jobId) {
        await progressManager.handleJobError(jobId, error);

        // Release URL back to Available status on error
        await jobQueueUrlService.handleJobCompletion(
          jobId,
          "Failed",
          error?.message || "Unknown error"
        );
      }

      // Finalize logging with failed status
      if (jobId) {
        await finalizeJobLogging("failed");
      }
      throw error;
    }
  } catch (error: any) {
    await dualLogError("Main function error:", error);

    // Send email notification for outer main function error
    if (jobId) {
      try {
        await emailNotifier.notifyJobError(
          jobId,
          error?.message || "Unknown error in outer main function",
          error,
          {
            stage: "outer_main_function",
            progressPercentage: progressManager.getJobProgress(jobId)?.progressPercentage,
            lastProcessedDate: progressManager.getJobLastProcessedDate(jobId) || undefined,
          }
        );
      } catch (emailError) {
        await dualLogError("Failed to send error notification email:", emailError);
      }
    }

    // End time session on error
    await timeManager.endSession();

    // Clean up progress file on main function error
    if (jobId) {
      await progressManager.handleJobError(jobId, error);

      // Release URL back to Available status on outer error
      await jobQueueUrlService.handleJobCompletion(
        jobId,
        "Failed",
        error?.message || "Unknown error"
      );
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
  user_password?: string
): Promise<void> {
  const environment = process.env.ENVIRONMENT || "production";
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
      if (environment === "production") {
        setupResult = await browserSetupProduction(jobId);
      } else {
        setupResult = await browserSetupLocal(jobId);
      }
      browser = setupResult.browser;
      const page = setupResult.page;

      await dualLogInfo(
        "Browser setup complete. Page is ready at login screen."
      );

      // Check if scraping is paused and wait if needed
      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        await dualLogInfo("Scraping was stopped, exiting...");
        await browser.close();
        if (jobId) {
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
              await finalizeJobLogging("failed");
            }
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
            if (jobId) {
              await finalizeJobLogging("failed");
            }
            return;
          }

          await handleOtpVerification(browser, page, jobId);
          await dualLogInfo("OTP verification completed successfully!");
        } catch (error: any) {
          await dualLogError("OTP verification failed:", error);
          
          // Send email notification for OTP verification error
          if (jobId) {
            try {
              await emailNotifier.notifyJobError(
                jobId,
                `OTP verification failed: ${error?.message || "Unknown OTP error"}`,
                error,
                {
                  stage: "otp_verification",
                  progressPercentage: progressManager.getJobProgress(jobId)?.progressPercentage,
                }
              );
            } catch (emailError) {
              await dualLogError("Failed to send OTP error notification email:", emailError);
            }
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
              "Property search and reservation completed successfully!"
            );
          } catch (error: any) {
            await dualLogError("Property search failed:", error);
            
            // Send email notification for property search error
            if (jobId) {
              try {
                await emailNotifier.notifyJobError(
                  jobId,
                  `Property search failed: ${error?.message || "Unknown property search error"}`,
                  error,
                  {
                    progressPercentage: progressManager.getJobProgress(jobId)?.progressPercentage,
                  }
                );
              } catch (emailError) {
                await dualLogError("Failed to send property search error notification email:", emailError);
              }
            }
            
            throw error;
          }
        } else {
          await dualLogInfo(
            "No expedia ID provided, skipping property search."
          );
        }

        // Step 4: Process date range with time management
        try {
          if (currentStartDate && endDate && expediaId) {
            // Check pause state before date splitting
            await scrapingStateManager.waitWhilePaused();
            if (!scrapingStateManager.isRunning()) {
              await dualLogInfo("Scraping was stopped, exiting...");
              await browser.close();
              if (jobId) {
                await finalizeJobLogging("failed");
              }
              return;
            }

            await splitDateRange(
              browser,
              page,
              currentStartDate,
              endDate,
              expediaId,
              jobId
            );

            // If we reach here, all dates were processed successfully
            await dualLogInfo("All dates processed successfully!");
            // Close browser when done with this attempt
            if (browser) {
              await browser.close();
              browser = null;
            }
            await dualLogInfo("Browser closed successfully.");
            break; // Exit the retry loop
          } else {
            await dualLogInfo(
              "No start date or end date, or expedia ID provided, skipping date selection."
            );
            break; // Exit the retry loop
          }
        } catch (error: any) {
          // Check if this is a browser restart error
          if (error.message.startsWith("BROWSER_RESTART_NEEDED:")) {
            const resumeDate = error.message.split(":")[1];
            await dualLogInfo(
              `Browser restart needed. Will resume from: ${resumeDate}`,
              {
                jobId,
                resumeDate,
                currentStartDate,
                endDate,
                attemptCount,
                timeSession: timeManager.getSessionInfo(),
                dateComparison: endDate
                  ? compareDates(resumeDate, endDate)
                  : null,
              }
            );

            // Close current browser
            if (browser) {
              await browser.close();
              browser = null;
            }

            // Reset time session for next attempt
            await timeManager.resetSession(jobId);

            // Update the start date for next iteration
            currentStartDate = resumeDate;

            await dualLogInfo(`Updated currentStartDate for next iteration`, {
              jobId,
              newCurrentStartDate: currentStartDate,
              endDate,
              willContinue:
                currentStartDate && endDate
                  ? compareDates(currentStartDate, endDate) <= 0
                  : false,
              attemptCount: attemptCount + 1,
            });

            // Continue to next iteration (browser restart)
            continue;
          } else {
            // Other errors should be propagated
            await dualLogError("Date selection failed:", error);
            
            // Send email notification for date selection error
            if (jobId) {
              try {
                await emailNotifier.notifyJobError(
                  jobId,
                  `Date selection failed: ${error?.message || "Unknown date selection error"}`,
                  error,
                  {
                    stage: "date_selection",
                    progressPercentage: progressManager.getJobProgress(jobId)?.progressPercentage,
                    lastProcessedDate: progressManager.getJobLastProcessedDate(jobId) || undefined,
                  }
                );
              } catch (emailError) {
                await dualLogError("Failed to send date selection error notification email:", emailError);
              }
            }
            
            // Close browser when done with this attempt
            if (browser) {
              await browser.close();
              browser = null;
            }
            await dualLogInfo("Browser closed successfully.");
            throw error;
          }
        }
      } else {
        await dualLogInfo("No login credentials provided.");
        await dualLogInfo("Browser closed successfully.");
        // Close browser when done with this attempt
        if (browser) {
          await browser.close();
        }
        break; // Exit the retry loop
      }
    } catch (error: any) {
      await dualLogError(`Scraping attempt ${attemptCount} failed:`, error);

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
        // Send email notification for scraping attempt error
        if (jobId) {
          try {
            await emailNotifier.notifyJobError(
              jobId,
              `Scraping attempt ${attemptCount} failed: ${error?.message || "Unknown scraping error"}`,
              error,
              {
                stage: `scraping_attempt_${attemptCount}`,
                progressPercentage: progressManager.getJobProgress(jobId)?.progressPercentage,
                lastProcessedDate: progressManager.getJobLastProcessedDate(jobId) || undefined,
              }
            );
          } catch (emailError) {
            await dualLogError("Failed to send scraping attempt error notification email:", emailError);
          }
        }
        
        // Clean up progress file on error
        if (jobId) {
          await progressManager.handleJobError(jobId, error);

          // Release URL back to Available status on browser crash
          await jobQueueUrlService.handleJobCompletion(
            jobId,
            "Failed",
            error?.message || "Unknown error"
          );
        }
        throw error;
      }
    }
  }

  if (attemptCount >= maxAttempts) {
    const maxAttemptsError = new Error(
      `Maximum restart attempts (${maxAttempts}) exceeded`
    );
    
    // Send email notification for max attempts exceeded
    if (jobId) {
      try {
        await emailNotifier.notifyJobError(
          jobId,
          `Maximum restart attempts (${maxAttempts}) exceeded`,
          maxAttemptsError,
          {
            stage: "max_attempts_exceeded",
            progressPercentage: progressManager.getJobProgress(jobId)?.progressPercentage,
            lastProcessedDate: progressManager.getJobLastProcessedDate(jobId) || undefined,
          }
        );
      } catch (emailError) {
        await dualLogError("Failed to send max attempts error notification email:", emailError);
      }
    }
    
    // Clean up progress file when max attempts exceeded
    if (jobId) {
      await progressManager.handleJobError(jobId, maxAttemptsError);

      // Release URL back to Available status when max attempts exceeded
      await jobQueueUrlService.handleJobCompletion(
        jobId,
        "Failed",
        maxAttemptsError.message
      );
    }
    throw maxAttemptsError;
  }

  await dualLogInfo("Scraping completed successfully!", {
    totalAttempts: attemptCount,
    jobId,
  });
}

export default main;
