import dotenv from "dotenv";
import { browserSetup } from "./browser-setup/browser.js";
import { delay } from "./common/delay.js";
import { decryptPassword } from "./common/encription.js";
import {
  dualLogError,
  dualLogInfo,
  finalizeJobLogging,
  initializeJobLogging,
} from "./common/log-helper.js";
import { scrapingStateManager } from "./common/scraping-state.js";
import { splitDateRange } from "./date-split/date-split.js";
import login from "./login/login.js";
import handleOtpVerification from "./otp-verification/otp-verification.js";
import { propertySearchAndClickReservation } from "./property-search/property-search.js";

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

  try {
    // Initialize job logging if jobId is provided
    if (jobId) {
      jobLogger = initializeJobLogging(jobId);
      await dualLogInfo(`Starting job ${jobId}`, {
        expediaId,
        startDate,
        endDate,
        user_email: user_email ? "[REDACTED]" : undefined,
      });
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
      // Step 1: Setup browser and navigate to login page
      await dualLogInfo("Setting up browser...");

      const { browser, page } = await browserSetup(jobId);

      await dualLogInfo(
        "Browser setup complete. Page is ready at login screen."
      );

      // Check if scraping is paused and wait if needed
      await scrapingStateManager.waitWhilePaused();

      // Check if scraping was stopped while paused
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

          await handleOtpVerification(page, jobId);
          await dualLogInfo("OTP verification completed successfully!");
        } catch (error: any) {
          await dualLogError("OTP verification failed:", error);
          // Continue even if OTP fails as it might not be required
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

            await propertySearchAndClickReservation(page, expediaId, jobId);

            await dualLogInfo(
              "Property search and reservation completed successfully!"
            );
          } catch (error: any) {
            await dualLogError("Property search failed:", error);
            throw error;
          }
        } else {
          await dualLogInfo(
            "No expedia ID provided, skipping property search."
          );
        }

        try {
          if (startDate && endDate && expediaId) {
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

            await splitDateRange(page, startDate, endDate, expediaId, jobId);
          } else {
            await dualLogInfo(
              "No start date or end date, or expedia ID provided, skipping date selection."
            );
          }
          await dualLogInfo("Date selection completed successfully!");
        } catch (error: any) {
          await dualLogError("Date selection failed:", error);
          throw error;
        }
      } else {
        await dualLogInfo("No login credentials provided.");
      }

      // Close browser when done
      await browser.close();
      // await client.sessions.release(session.id);
      await dualLogInfo("Browser closed successfully.");

      // Finalize logging with success status
      if (jobId) {
        await finalizeJobLogging("success");
      }
    } catch (error) {
      await dualLogError("Main function error:", error);

      // Finalize logging with failed status
      if (jobId) {
        await finalizeJobLogging("failed");
      }
      throw error;
    }
  } catch (error) {
    await dualLogError("Main function error:", error);

    // Finalize logging with failed status
    if (jobId) {
      await finalizeJobLogging("failed");
    }
    throw error;
  }
}

export default main;
