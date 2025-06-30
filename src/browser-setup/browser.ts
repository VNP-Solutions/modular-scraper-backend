import dotenv from "dotenv";
import puppeteer, { Browser, Page } from "puppeteer";
import { delay } from "../common/delay.js";
import {
  dualLogError,
  dualLogInfo,
  dualLogWarn,
} from "../common/log-helper.js";
import { timeoutManager } from "../common/timeout-manager.js";
dotenv.config();

export async function browserSetup(jobId?: string): Promise<{
  browser: Browser;
  page: Page;
}> {
  let browser: Browser | null = null;

  try {
    // browser = await puppeteer.launch({
    //   headless: false,
    //   defaultViewport: null,
    //   args: [
    //     "--start-maximized",
    //     "--no-sandbox",
    //     "--disable-setuid-sandbox",
    //     "--disable-web-security",
    //     "--disable-features=IsolateOrigins,site-per-process",
    //     "--disable-blink-features=AutomationControlled",
    //     "--disable-extensions",
    //     // "--proxy-server=brd.superproxy.io:33335",
    //   ],
    // });

    // Get timeout configuration for this job
    const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);
    const selectorTimeout = await timeoutManager.getSelectorTimeout(jobId);

    const launchArgs = {
      headless: false,
      stealth: false,
      args: ['--window-size=1920,1080']
    };
    
    // Create query parameters
    const queryParams = new URLSearchParams({
      token: `${process.env.BROWSERLESS_TOKEN}`,
      // proxy: 'residential',
      // proxyCountry: 'us',
      launch: JSON.stringify(launchArgs)
    });
    
     browser = await puppeteer.connect({
      browserWSEndpoint: `wss://production-sfo.browserless.io?${queryParams.toString()}`,
    });
    const page: Page = await browser.newPage();
    const cdp = await page.createCDPSession();
    await (cdp as any).send("Browserless.startRecording");
    await dualLogInfo("Recording started successfully");

    // Wait a bit before generating live URL
    await delay(2000);

    // Generate live URL for user interaction
    const { liveURL } = (await (cdp as any).send("Browserless.liveURL", {
      timeout: 600_000,
    })) as { liveURL: string };
    await dualLogInfo("Click for live experience:", { liveURL });

    // const client = await page.createCDPSession();
    // console.log("client", client);
    // await openDevtools(page, client);

    //ip check

    // try {
    //   await page.goto("https://api.ipify.org/?format=json");
    //   const ipData = await page.evaluate(() => document.body.textContent);
    //   if (!ipData) {
    //     throw new Error("Failed to get IP data");
    //   }
    //   const ip = JSON.parse(ipData).ip;
    //   console.log("Current IP:", ip);
    //   // const location = (await ipLocation(ip)) as any;
    //   // console.log("Location:", location);
    //   // if (location?.country?.code !== process.env.LOCATION_COUNTRY_CODE) {
    //   //   console.log("Not in United States - Stopping server");
    //   //   process.exit(1);
    //   // }
    // } catch (error) {
    //   console.error("Error checking IP:", error);
    //   process.exit(1);
    // }

    // await page.authenticate({
    //   username: `${process.env.BRIGHT_DATA_USERNAME}`,
    //   password: `${process.env.BRIGHT_DATA_PASSWORD}`,
    // });
    // Set user agent to avoid detection
    // await page.setUserAgent(
    //   "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    // );

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
          throw navError;
        }
      }
    }

    if (!navigationSuccess) {
      throw new Error(
        "Failed to navigate to the target page after all attempts"
      );
    }

    await dualLogInfo("Browser setup completed successfully");
    return { browser, page };
  } catch (error) {
    await dualLogError("Browser setup failed:", error);

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
