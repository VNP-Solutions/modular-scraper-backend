import dotenv from "dotenv";
import puppeteer, { Browser, Page } from "puppeteer";
import { delay } from "../common/delay.js";
import {
  dualLogError,
  dualLogInfo,
  dualLogWarn,
} from "../common/log-helper.js";
import { progressManager } from "../common/progress-manager.js";
import { timeoutManager } from "../common/timeout-manager.js";
dotenv.config();

export async function browserSetupLocal(jobId?: string): Promise<{
  browser: Browser;
  page: Page;
}> {
  let browser: Browser | null = null;

  try {
    try {
      browser = await puppeteer.launch({
        headless: true,
        defaultViewport: null,
        args: [
          "--start-maximized",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-web-security",
          "--disable-features=IsolateOrigins,site-per-process",
          "--disable-blink-features=AutomationControlled",
          "--disable-extensions",
        ],
      });
    } catch (error: any) {
      await dualLogError("Error launching browser:", error);
      
      // Send email notification for browser launch error
      if (jobId) {
        try {        } catch (emailError) {
          await dualLogError("Failed to send browser launch error notification:", emailError);
        }
      }
      throw error;
    }

    // Get timeout configuration for this job
    const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);
    const selectorTimeout = await timeoutManager.getSelectorTimeout(jobId);

    const page: Page = await browser.newPage();

    // Set user agent to avoid detection
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );
    // Set default timeouts based on job configuration
    await page.setDefaultNavigationTimeout(loadingTimeout);
    await page.setDefaultTimeout(selectorTimeout);

    // Navigate to partner central with retry logic
    await dualLogInfo("Navigating to Expedia Partner Central...");

    const maxRetries = 3;
    let navigationSuccess = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await dualLogInfo(`Navigation attempt ${attempt}/${maxRetries}`, {
          attempt,
          maxRetries,
        });

        await page.goto(
          "https://www.expediapartnercentral.com/Account/Logon?signedOff=true",
          {
            waitUntil: "domcontentloaded",
            timeout: loadingTimeout,
          }
        );

        // Wait for page to stabilize
        await delay(3000);

        // Check if page loaded successfully by looking for a common element
        await page.waitForSelector("body", { timeout: selectorTimeout });

        navigationSuccess = true;
        await dualLogInfo("Navigation successful!", { attempt });
        break;
      } catch (navError: any) {
        await dualLogWarn(`Navigation attempt ${attempt} failed:`, {
          attempt,
          error: navError.message,
        });

        if (attempt < maxRetries) {
          await dualLogInfo("Retrying navigation...", { attempt });
          await delay(2000); // Wait before retry
        } else {
          await dualLogError("All navigation attempts failed", navError, {
            maxRetries,
          });
          
          // Send email notification for navigation failure
          if (jobId) {
            try {            } catch (emailError) {
              await dualLogError("Failed to send navigation error notification:", emailError);
            }
          }
          
          throw navError;
        }
      }
    }

    if (!navigationSuccess) {
      const error = new Error(
        "Failed to navigate to the target page after all attempts"
      );
      
      // Send email notification for navigation failure
      if (jobId) {
        try {        } catch (emailError) {
          await dualLogError("Failed to send final navigation error notification:", emailError);
        }
      }
      
      throw error;
    }

    await dualLogInfo("Browser setup completed successfully");
    return { browser, page };
  } catch (error: any) {
    await dualLogError("Browser setup failed:", error);

    // Send email notification for general browser setup error
    if (jobId) {
      try {      } catch (emailError) {
        await dualLogError("Failed to send browser setup error notification:", emailError);
      }
    }

    // Clean up browser if it was created
    if (browser) {
      try {
        await browser.close();
        // await session.release();
      } catch (closeError) {
        await dualLogError("Error closing browser:", closeError);
      }
    }

    throw error;
  }
}
