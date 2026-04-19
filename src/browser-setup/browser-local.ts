import dotenv from "dotenv";
import puppeteer, { Browser, Page } from "puppeteer";
// @ts-ignore — puppeteer-extra ships its own types but they don't expose `.use` well under NodeNext
import puppeteerExtra from "puppeteer-extra";
// @ts-ignore — same as above
import StealthPlugin from "puppeteer-extra-plugin-stealth";
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
import { configs } from "../config/index.js";
dotenv.config();

// Activate stealth only once at module load.
puppeteerExtra.use(StealthPlugin());

const COOKIE_KEY = "expedia-partner-central";
const HOME_URL = "https://www.expediapartnercentral.com/";
const LOGIN_URL =
  "https://www.expediapartnercentral.com/Account/Logon?signedOff=true";

export async function browserSetupLocal(
  jobId?: string,
  platform?: "expedia"
): Promise<{
  browser: Browser;
  page: Page;
}> {
  let browser: Browser | null = null;

  try {
    try {
      browser = (await puppeteerExtra.launch({
        headless: configs.headless_browser,
        defaultViewport: null,
        args: BROWSER_CONFIG.LAUNCH_ARGS,
        // Use the Chromium that ships with puppeteer so the UA we build
        // matches the actual binary version.
        executablePath: puppeteer.executablePath(),
        ignoreDefaultArgs: ["--enable-automation"],
      })) as unknown as Browser;
    } catch (error: any) {
      await dualLogError("Error launching browser:", error);
      if (jobId) {
        try {
        } catch (emailError) {
          await dualLogError(
            "Failed to send browser launch error notification:",
            emailError
          );
        }
      }
      throw error;
    }

    const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);
    const selectorTimeout = await timeoutManager.getSelectorTimeout(jobId);

    const page: Page = await browser.newPage();

    // Sync UA / client-hints with the *actual* bundled Chromium version.
    const rawUA = await browser.userAgent();
    const { userAgent, headers } = buildClientHintsFromUA(rawUA);
    await page.setUserAgent(userAgent);
    await page.setExtraHTTPHeaders(headers);
    await dualLogInfo("Spoofed UA in sync with bundled Chromium", {
      userAgent,
    });

    // Realistic viewport + locale so fingerprint checks line up.
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
      /* noop — timezone override can fail on some Chromium builds */
    }

    // Small extra hardening on top of stealth plugin. Stealth already covers
    // navigator.webdriver, plugins, chrome.runtime, permissions, WebGL, etc.,
    // but we add a couple of Expedia-specific nice-to-haves.
    await page.evaluateOnNewDocument(() => {
      // Realistic hardware profile
      Object.defineProperty(navigator, "hardwareConcurrency", {
        get: () => 8,
      });
      Object.defineProperty(navigator, "deviceMemory", {
        get: () => 8,
      });
      // Consistent languages
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      });
    });

    await page.setDefaultNavigationTimeout(loadingTimeout);
    await page.setDefaultTimeout(selectorTimeout);

    // Restore any previously valid Akamai cookies (_abck, bm_sz, ak_bmsc, …)
    // so we don't start from a cold reputation.
    await loadCookies(page, COOKIE_KEY);

    const platformName = "Expedia";
    await dualLogInfo(`Navigating to ${platformName} platform...`);

    const maxRetries = 3;
    let navigationSuccess = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await dualLogInfo(`Navigation attempt ${attempt}/${maxRetries}`, {
          attempt,
          maxRetries,
        });

        // ---- Warm-up on the homepage ----
        // Akamai Bot Manager expects a few mousemove / scroll events on a
        // non-protected page before issuing a valid _abck cookie. Hitting
        // /Account/Logon cold is the #1 reason you get "access denied".
        await page.goto(HOME_URL, {
          waitUntil: "domcontentloaded",
          timeout: loadingTimeout,
        });
        await humanDelay(1500, 2500);
        await humanMouseWander(page, 6);
        await humanScroll(page, 3);
        await humanDelay(800, 1600);

        // ---- Now go to the real login page ----
        await page.goto(LOGIN_URL, {
          waitUntil: "domcontentloaded",
          timeout: loadingTimeout,
        });

        await delay(2500);

        // Quick access-denied sniff so we fail fast instead of hanging.
        const pageContent = await page.content();
        const pageUrl = page.url();
        const denied =
          /Access Denied|You don't have permission|Reference #\d+/i.test(
            pageContent
          ) ||
          pageUrl.includes("account.expediagroup.com") === false &&
            /access denied/i.test(pageContent);

        if (denied) {
          await dualLogWarn(
            "Akamai / bot-manager returned Access Denied on attempt " + attempt
          );
          throw new Error("Bot-manager Access Denied");
        }

        await page.waitForSelector("body", { timeout: selectorTimeout });

        // A little human activity on the login page too.
        await humanMouseWander(page, 3);

        // Persist the freshly minted Akamai cookies for the next run.
        await saveCookies(page, COOKIE_KEY);

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
          // Back-off grows with each attempt
          await delay(2000 * attempt + Math.floor(Math.random() * 1500));
        } else {
          await dualLogError("All navigation attempts failed", navError, {
            maxRetries,
          });

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

    if (jobId) {
      try {
      } catch (emailError) {
        await dualLogError(
          "Failed to send browser setup error notification:",
          emailError
        );
      }
    }

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
