import dotenv from "dotenv";
import { Browser } from "puppeteer";
import { browserSetupLocal } from "../browser-setup/browser-local.js";
import { browserSetupProduction } from "../browser-setup/browser-prod.js";
import { delay } from "../common/delay.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { progressManager } from "../common/progress-manager.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import login from "../login/login.js";
import handleOtpVerification from "../otp-verification/otp-verification.js";
import scrapeWithReservationId from "../retry-scrape-data/scrape-with-reservationid.js";
dotenv.config();

// Initialize Steel client
// const client = new Steel({
//   steelAPIKey: process.env.STEEL_API_KEY, // Optional
// });

async function reservation(
  browser: Browser | null,
  reservations: any[]
): Promise<void> {
  const jobId = `reservation_job_${Date.now()}`; // Generate job ID for reservation function

  try {
    const environment = process.env.ENVIRONMENT || "production";
    // Create a new session
    // const session = await client.sessions.create();

    // Step 1: Setup browser and navigate to login page
    await dualLogInfo("Setting up browser...");
    let setupResult = null;

    try {
      if (environment === "production") {
        setupResult = await browserSetupProduction(jobId);
      } else {
        setupResult = await browserSetupLocal(jobId);
      }
    } catch (error: any) {
      await dualLogError("Browser setup failed:", error);

      // Send email notification for browser setup error
      try {      } catch (emailError) {
        await dualLogError(
          "Failed to send browser setup error notification:",
          emailError
        );
      }

      throw error;
    }

    browser = setupResult.browser;
    const page = setupResult.page;
    await dualLogInfo("Browser setup complete. Page is ready at login screen.");

    // Step 2: Check if login credentials are provided
    const email = process.env.EXPEDIA_EMAIL;
    const password = process.env.EXPEDIA_PASSWORD;

    if (email && password) {
      await dualLogInfo(
        "Login credentials found, performing automatic login..."
      );

      try {
        await login(browser, page, email, password, jobId);
        console.log("Login completed successfully! User is now logged in.");

        // Add your post-login automation here
        console.log("Ready for scraping operations...");
        await delay(10000);
      } catch (loginError: any) {
        console.error("Login failed:", loginError);

        // Send email notification for login error
        try {        } catch (emailError) {
          await dualLogError(
            "Failed to send login error notification:",
            emailError
          );
        }

        throw loginError;
      }

      try {
        await handleOtpVerification(browser, page, jobId);
        console.log("OTP verification completed successfully!");
      } catch (error: any) {
        console.error("OTP verification failed:", error);

        // Send email notification for OTP verification error
        try {        } catch (emailError) {
          await dualLogError(
            "Failed to send OTP verification error notification:",
            emailError
          );
        }

        throw error;
      }

      // Step 3: Perform reservation scraping
      if (reservations.length > 0) {
        try {
          // Update progress with total count
          scrapingStateManager.updateProgress(
            undefined,
            undefined,
            0,
            reservations.length
          );

          let processedCount = 0;
          for (const reservation of reservations) {
            // Check if scraping is paused and wait if needed
            await scrapingStateManager.waitWhilePaused();

            // Check if scraping was stopped while paused
            if (!scrapingStateManager.isRunning()) {
              await dualLogError("Scraping was stopped, exiting...");
              return;
            }

            await dualLogInfo(
              `Processing reservation ${processedCount + 1}/${
                reservations.length
              }`
            );

            try {
              await scrapeWithReservationId(browser, page, reservation, jobId);
              processedCount++;

              // Update progress
              scrapingStateManager.updateProgress(
                undefined,
                undefined,
                processedCount,
                reservations.length
              );
            } catch (reservationError: any) {
              await dualLogError(
                `Error processing reservation ${processedCount + 1}:`,
                reservationError
              );

              // Send email notification for individual reservation error
              try {              } catch (emailError) {
                await dualLogError(
                  "Failed to send individual reservation error notification:",
                  emailError
                );
              }

              // Continue with next reservation instead of failing completely
              processedCount++;
              continue;
            }
          }
        } catch (error: any) {
          await dualLogError("Reservation search failed:", error);

          // Send email notification for general reservation processing error
          try {          } catch (emailError) {
            await dualLogError(
              "Failed to send reservation processing error notification:",
              emailError
            );
          }

          throw error;
        }
      } else {
        await dualLogInfo(
          "No reservations provided, skipping reservation search."
        );
      }
    } else {
      const error = new Error("No login credentials provided");
      await dualLogInfo("No login credentials provided.");

      // Send email notification for missing credentials
      try {      } catch (emailError) {
        await dualLogError(
          "Failed to send credentials missing error notification:",
          emailError
        );
      }

      // Close browser when done with this attempt
      if (browser) {
        await browser.close();
      }
      await dualLogInfo("Browser closed successfully.");

      throw error;
    }
  } catch (error: any) {
    await dualLogError("Reservation function error:", error);

    // Send email notification for general reservation function error
    try {    } catch (emailError) {
      await dualLogError(
        "Failed to send reservation function error notification:",
        emailError
      );
    }

    // Close browser when done with this attempt
    if (browser) {
      await browser.close();
    }
    await dualLogInfo("Browser closed successfully.");
    throw error;
  }
}

export default reservation;
