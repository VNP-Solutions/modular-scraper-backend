import dotenv from "dotenv";
import puppeteer, { Browser, Page } from "puppeteer";
import { delay } from "../common/delay.js";
import {
  dualLogError,
  dualLogInfo,
  dualLogWarn,
} from "../common/log-helper.js";
import { timeoutManager } from "../common/timeout-manager.js";
import { JobService } from "../services/job.service.js";
dotenv.config();

export async function browserSetupProduction(
  jobId?: string,
  platform?: "expedia" | "agoda"
): Promise<{
  browser: Browser;
  page: Page;
}> {
  let browser: Browser | null = null;

  try {
    // Get timeout configuration for this job
    const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);
    const selectorTimeout = await timeoutManager.getSelectorTimeout(jobId);

    const launchArgs = {
      headless: true,
      stealth: false,
      args: ["--window-size=1920,1080"],
    };

    // Create query parameters
    const queryParams = new URLSearchParams({
      token: `${process.env.BROWSERLESS_TOKEN}`,
      // proxy: 'residential',
      // proxyCountry: 'us',
      launch: JSON.stringify(launchArgs),
    });

    try {
      browser = await puppeteer.connect({
        // browserWSEndpoint: `wss://production-sfo.browserless.io?${queryParams.toString()}`,
        browserWSEndpoint:
          "wss://production-sfo.browserless.io?token=2SXlnLjeZpwR2tV6ab1698bfe680a3959c2c681f06939ee3b",
      });
    } catch (error: any) {
      await dualLogError("Error connecting to Browserless:", error);

      // Send email notification for browser connection error
      if (jobId) {
        try {
        } catch (emailError) {
          await dualLogError(
            "Failed to send browser connection error notification:",
            emailError
          );
        }
      }
      throw error;
    }

    const page: Page = await browser.newPage();
    const cdp = await page.createCDPSession();

    try {
      await (cdp as any).send("Browserless.startRecording");
      await dualLogInfo("Recording started successfully");
    } catch (error: any) {
      await dualLogError("Error starting recording:", error);

      // Send email notification for recording start error
      if (jobId) {
        try {
        } catch (emailError) {
          await dualLogError(
            "Failed to send recording start error notification:",
            emailError
          );
        }
      }
      // Don't throw here, recording is not critical
    }

    // // Wait a bit before generating live URL
    await delay(2000);

    // Generate live URL for user interaction
    let liveURL: string | null = null;
    try {
      const liveUrlResponse = (await (cdp as any).send("Browserless.liveURL", {
        timeout: 600_000,
      })) as { liveURL: string };
      liveURL = liveUrlResponse.liveURL;
      await dualLogInfo("Click for live experience:", { liveURL });
    } catch (error: any) {
      await dualLogError("Error generating live URL:", error);

      // Send email notification for live URL generation error
      if (jobId) {
        try {
        } catch (emailError) {
          await dualLogError(
            "Failed to send live URL error notification:",
            emailError
          );
        }
      }
      // Continue without live URL
    }

    // Store live URL in database if jobId is provided
    if (jobId && liveURL) {
      try {
        const jobService = new JobService();
        const updatedJob = await jobService.updateJobLiveUrl(jobId, liveURL);
        if (updatedJob) {
          await dualLogInfo(`Live URL stored successfully for job: ${jobId}`);
        } else {
          await dualLogWarn(`Failed to store live URL for job: ${jobId}`);
        }
      } catch (error: any) {
        await dualLogError("Error storing live URL in database:", error);

        // Send email notification for live URL storage error
        if (jobId) {
          try {
          } catch (emailError) {
            await dualLogError(
              "Failed to send live URL storage error notification:",
              emailError
            );
          }
        }
        // Continue even if storage fails
      }
    }

    // Set default timeouts based on job configuration
    await page.setDefaultNavigationTimeout(loadingTimeout);
    await page.setDefaultTimeout(selectorTimeout);

    // Navigate to partner central with retry logic
    const platformName = platform === "agoda" ? "Agoda" : "Expedia";
    await dualLogInfo(`Navigating to ${platformName} platform...`);

    const maxRetries = 3;
    let navigationSuccess = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await dualLogInfo(`Navigation attempt ${attempt}/${maxRetries}`, {
          attempt,
          maxRetries,
        });

        if (platform === "expedia") {
          await page.goto(
            "https://www.expediapartnercentral.com/Account/Logon?signedOff=true",
            {
              waitUntil: "domcontentloaded",
              timeout: loadingTimeout,
            }
          );
        } else if (platform === "agoda") {
          // Navigate directly to the login page to avoid redirect timing issues
          await page.goto("https://portal.agoda.com/mldc/en-us/public/login", {
            waitUntil: "networkidle2", // Wait for network to be idle to handle redirects
            timeout: 0, // No timeout for Agoda navigation
          });
        } else {
          // Default to Expedia for backward compatibility
          await page.goto(
            "https://www.expediapartnercentral.com/Account/Logon?signedOff=true",
            {
              waitUntil: "domcontentloaded",
              timeout: loadingTimeout,
            }
          );
        }

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
            try {
            } catch (emailError) {
              await dualLogError(
                "Failed to send navigation error notification:",
                emailError
              );
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

      // Send email notification for final navigation failure
      if (jobId) {
        try {
        } catch (emailError) {
          await dualLogError(
            "Failed to send final navigation error notification:",
            emailError
          );
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
      try {
      } catch (emailError) {
        await dualLogError(
          "Failed to send browser setup error notification:",
          emailError
        );
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
