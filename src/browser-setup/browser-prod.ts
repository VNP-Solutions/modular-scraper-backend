import dotenv from "dotenv";
import puppeteer, { Browser, Page } from "puppeteer";
import {
  BROWSER_CONFIG,
  buildClientHintsFromUA,
} from "../common/browser-constants.js";
import { loadCookies, saveCookies } from "../common/cookie-jar.js";
import { delay } from "../common/delay.js";
import {
  humanDelay,
  humanMouseWander,
  humanScroll,
} from "../common/human-behavior.js";
import {
  dualLogError,
  dualLogInfo,
  dualLogWarn,
} from "../common/log-helper.js";
import { timeoutManager } from "../common/timeout-manager.js";
import { JobService } from "../services/job.service.js";
dotenv.config();

const EXPEDIA_COOKIE_KEY = "expedia-partner-central";
const EXPEDIA_HOME_URL = "https://www.expediapartnercentral.com/";
const EXPEDIA_LOGIN_URL =
  "https://www.expediapartnercentral.com/Account/Logon?signedOff=true";

const DENIAL_PATTERNS = [
  /Access Denied/i,
  /You don'?t have permission/i,
  /Reference\s*#\d/i,
  /Pardon Our Interruption/i,
  /request (?:was|has been) blocked/i,
];

function isDeniedPage(url: string, html: string): boolean {
  if (url.startsWith("chrome-error://")) return true;
  return DENIAL_PATTERNS.some((re) => re.test(html));
}

export async function browserSetupProduction(
  jobId?: string,
  platform?: "expedia" | "agoda"
): Promise<{
  browser: Browser;
  page: Page;
}> {
  let browser: Browser | null = null;

  try {
    const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);
    const selectorTimeout = await timeoutManager.getSelectorTimeout(jobId);

    // Browserless launch options.
    //   - stealth: true   → server-side puppeteer-extra-plugin-stealth
    //   - headless: true  → classic headless (Browserless handles fingerprinting)
    const launchArgs = {
      headless: true,
      stealth: true,
      args: [
        "--window-size=1920,1080",
        "--disable-blink-features=AutomationControlled",
      ],
    };

    // Optional: enable residential proxy. Akamai blocks most datacenter IPs,
    // so residential is strongly recommended. Toggle via env var.
    const useResidentialProxy =
      (process.env.BROWSERLESS_USE_RESIDENTIAL || "").toLowerCase() === "true";

    const queryParams = new URLSearchParams({
      token: `${process.env.BROWSERLESS_TOKEN}`,
      launch: JSON.stringify(launchArgs),
    });
    if (useResidentialProxy) {
      queryParams.set("proxy", "residential");
      queryParams.set(
        "proxyCountry",
        process.env.BROWSERLESS_PROXY_COUNTRY || "us"
      );
      queryParams.set("proxySticky", "true");
    }

    try {
      const wsEndpoint =
        process.env.BROWSERLESS_WS_ENDPOINT ||
        `wss://production-sfo.browserless.io?${queryParams.toString()}`;
      browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    } catch (error: any) {
      await dualLogError("Error connecting to Browserless:", error);
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

    // Sync UA / client-hints with the actual remote Chromium version.
    try {
      const rawUA = await browser.userAgent();
      const { userAgent, headers } = buildClientHintsFromUA(rawUA);
      await page.setUserAgent(userAgent);
      await page.setExtraHTTPHeaders(headers);
      await dualLogInfo("Spoofed UA in sync with remote Chromium", { userAgent });
    } catch (err: any) {
      await dualLogWarn(
        "Could not auto-sync UA, falling back to static constants: " + err.message
      );
      await page.setUserAgent(BROWSER_CONFIG.USER_AGENT);
      await page.setExtraHTTPHeaders(BROWSER_CONFIG.HEADERS);
    }

    await page.setViewport({
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      hasTouch: false,
      isLandscape: true,
      isMobile: false,
    });
    try {
      await page.emulateTimezone("America/New_York");
    } catch {
      /* noop */
    }

    // Fingerprint hardening on top of Browserless's stealth.
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
      Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      (window as any).chrome = (window as any).chrome || { runtime: {} };
    });

    try {
      await (cdp as any).send("Browserless.startRecording");
      await dualLogInfo("Recording started successfully");
    } catch (error: any) {
      await dualLogError("Error starting recording:", error);
    }

    await delay(2000);

    let liveURL: string | null = null;
    try {
      const liveUrlResponse = (await (cdp as any).send("Browserless.liveURL", {
        timeout: 600_000,
      })) as { liveURL: string };
      liveURL = liveUrlResponse.liveURL;
      await dualLogInfo("Click for live experience:", { liveURL });
    } catch (error: any) {
      await dualLogError("Error generating live URL:", error);
    }

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
      }
    }

    await page.setDefaultNavigationTimeout(loadingTimeout);
    await page.setDefaultTimeout(selectorTimeout);

    const platformName = platform === "agoda" ? "Agoda" : "Expedia";
    await dualLogInfo(`Navigating to ${platformName} platform...`);

    const maxRetries = 3;
    let navigationSuccess = false;

    if (platform === "expedia" || !platform) {
      // ── Expedia path: warm-up + cookie persistence + bot-denial check ──
      await loadCookies(page, EXPEDIA_COOKIE_KEY);

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await dualLogInfo(`Navigation attempt ${attempt}/${maxRetries}`, {
            attempt,
            maxRetries,
          });

          // Warm-up on the homepage so Akamai can collect behavioral events
          // before we touch the protected login endpoint.
          await page.goto(EXPEDIA_HOME_URL, {
            waitUntil: "domcontentloaded",
            timeout: loadingTimeout,
          });
          await humanDelay(1500, 2500);
          await humanMouseWander(page, 6);
          await humanScroll(page, 3);
          await humanDelay(800, 1600);

          await page.goto(EXPEDIA_LOGIN_URL, {
            waitUntil: "domcontentloaded",
            timeout: loadingTimeout,
          });

          await delay(2500);

          const pageUrl = page.url();
          let pageContent = "";
          try {
            pageContent = await page.content();
          } catch {
            /* chrome-error pages sometimes can't return HTML */
          }

          if (isDeniedPage(pageUrl, pageContent)) {
            await dualLogWarn(
              "Akamai / bot-manager returned Access Denied on attempt " + attempt,
              { pageUrl }
            );
            throw new Error("Bot-manager Access Denied");
          }

          await page.waitForSelector("body", { timeout: selectorTimeout });
          await humanMouseWander(page, 3);
          await saveCookies(page, EXPEDIA_COOKIE_KEY);

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
            await delay(2000 * attempt + Math.floor(Math.random() * 1500));
          } else {
            await dualLogError("All navigation attempts failed", navError, { maxRetries });
            throw navError;
          }
        }
      }
    } else {
      // ── Agoda path: direct navigation to YCS ──
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await dualLogInfo(`Navigation attempt ${attempt}/${maxRetries}`, {
            attempt,
            maxRetries,
          });

          await page.goto("https://ycs.agoda.com/mldc/en-us/public/login", {
            waitUntil: "networkidle2",
            timeout: 0,
          });

          await delay(3000);
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
            await delay(2000);
          } else {
            await dualLogError("All navigation attempts failed", navError, { maxRetries });
            throw navError;
          }
        }
      }
    }

    if (!navigationSuccess) {
      throw new Error("Failed to navigate to the target page after all attempts");
    }

    await dualLogInfo("Browser setup completed successfully");
    return { browser, page };
  } catch (error: any) {
    await dualLogError("Browser setup failed:", error);
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        await dualLogError("Error closing browser:", closeError);
      }
    }
    throw error;
  }
}
