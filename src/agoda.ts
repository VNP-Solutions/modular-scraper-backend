import dotenv from "dotenv";
import { Browser } from "puppeteer";
import agodaLogin from "./agoda/login-system/login.js";
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
): Promise<void> {
  let browser: Browser | null = null;

  try {
    await dualLogInfo("Starting Agoda automation process");

    // Validate credentials first
    if (!agodaUsername || !agodaPassword) {
      throw new Error("Agoda username or password is not set");
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
    await dualLogInfo("Agoda automation process completed successfully");
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
