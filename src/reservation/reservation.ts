import dotenv from "dotenv";
import { Browser } from "puppeteer";
import { browserSetupLocal } from "../browser-setup/browser-local.js";
import { browserSetupProduction } from "../browser-setup/browser-prod.js";
import { delay } from "../common/delay.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
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
  try {
    const environment = process.env.ENVIRONMENT || "production";
    // Create a new session
    // const session = await client.sessions.create();

    // Step 1: Setup browser and navigate to login page
    await dualLogInfo("Setting up browser...");
    let setupResult = null;
    if (environment === "production") {
      setupResult = await browserSetupProduction(undefined, "expedia");
    } else {
      setupResult = await browserSetupLocal(undefined, "expedia");
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
        await login(browser, page, email, password);
        console.log("Login completed successfully! User is now logged in.");

        // Add your post-login automation here
        console.log("Ready for scraping operations...");
        await delay(10000);
      } catch (loginError) {
        console.error("Login failed:", loginError);
      }

      try {
        await handleOtpVerification(browser, page);
        console.log("OTP verification completed successfully!");
      } catch (error: any) {
        console.error("OTP verification failed:", error);
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

            await scrapeWithReservationId(browser, page, reservation);
            processedCount++;

            // Update progress
            scrapingStateManager.updateProgress(
              undefined,
              undefined,
              processedCount,
              reservations.length
            );
          }
        } catch (error: any) {
          await dualLogError("Reservation search failed:", error);
          throw error;
        }
      } else {
        await dualLogInfo(
          "No reservations provided, skipping reservation search."
        );
      }
    } else {
      await dualLogInfo("No login credentials provided.");
      // Close browser when done with this attempt
      if (browser) {
        await browser.close();
      }
      await dualLogInfo("Browser closed successfully.");
    }
  } catch (error) {
    await dualLogError("Reservation function error:", error);
    // Close browser when done with this attempt
    if (browser) {
      await browser.close();
    }
    await dualLogInfo("Browser closed successfully.");
    throw error;
  }
}

export default reservation;
