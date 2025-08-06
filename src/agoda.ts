import dotenv from "dotenv";
import { Browser } from "puppeteer";
import agodaLogin from "./agoda/login-system/login.js";
import { getAgodaBookingData } from "./agoda/booking-data/booking-data.js";
import { browserSetupLocal } from "./browser-setup/browser-local.js";
import { browserSetupProduction } from "./browser-setup/browser-prod.js";
import { dualLogError, dualLogInfo } from "./common/log-helper.js";

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

  try {
    await dualLogInfo("Starting Agoda automation process");

    // Validate credentials and required parameters first
    if (!agodaUsername || !agodaPassword) {
      throw new Error("Agoda username or password is not set");
    }

    if (!agodaId || !startDate || !endDate) {
      throw new Error(
        "agodaId, startDate, and endDate are required parameters"
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

    // Agoda login process
    await agodaLogin(browser, page, agodaUsername, agodaPassword, jobId);
    await dualLogInfo("Agoda login completed successfully");

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

    await dualLogInfo("Agoda automation process completed successfully");
    return bookingData;
  } catch (error: any) {
    await dualLogError("Error in Agoda automation:", error);

    // Send ONE email notification per job failure
    if (jobId) {
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
