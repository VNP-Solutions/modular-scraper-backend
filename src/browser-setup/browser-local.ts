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
import {
  getBrightDataCountry,
} from "../common/job-isolation.js";
import { timeoutManager } from "../common/timeout-manager.js";
import { configs } from "../config/index.js";
dotenv.config();

// Activate stealth only once at module load.
puppeteerExtra.use(StealthPlugin());

const EXPEDIA_COOKIE_KEY = "expedia-partner-central";
const EXPEDIA_HOME_URL = "https://www.expediapartnercentral.com/";
const EXPEDIA_LOGIN_URL =
  "https://www.expediapartnercentral.com/Account/Logon?signedOff=true";

/**
 * BRIGHT_DATA_ENABLED: explicit toggle (recommended).
 * - true / 1 / yes → use Bright Data proxy when BRIGHT_DATA_PROXY_HOST and session id are set
 * - false / 0 / no → never use the proxy (ignores BRIGHT_DATA_PROXY_HOST)
 * - unset → backward compatible: same as true when BRIGHT_DATA_PROXY_HOST is set (proxy on if host + session)
 */
function brightDataMode():
  | "off"
  | "on"
  | "auto" {
  const raw = process.env.BRIGHT_DATA_ENABLED;
  if (raw === undefined || String(raw).trim() === "") return "auto";
  const v = String(raw).trim().toLowerCase();
  if (["true", "1", "yes"].includes(v)) return "on";
  if (["false", "0", "no"].includes(v)) return "off";
  return "auto";
}

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

export async function browserSetupLocal(
  jobId?: string,
  platform?: "expedia" | "agoda",
  brightDataSessionId?: string,
  windowSize?: { width: number; height: number },
  timezone?: string,
  acceptLanguage?: string
): Promise<{
  browser: Browser;
  page: Page;
}> {
  let browser: Browser | null = null;

  try {
    const launchArgs = [...BROWSER_CONFIG.LAUNCH_ARGS];

    if (windowSize) {
      launchArgs.push(`--window-size=${windowSize.width},${windowSize.height}`);
    }

    const bdHasSession = Boolean(brightDataSessionId);
    const bdHasProxyHost = Boolean(process.env.BRIGHT_DATA_PROXY_HOST);
    const bdHasCredentials = Boolean(
      process.env.BRIGHT_DATA_USERNAME && process.env.BRIGHT_DATA_PASSWORD
    );
    const bdMode = brightDataMode();
    const bdUseProxy =
      bdMode !== "off" &&
      bdHasSession &&
      bdHasProxyHost &&
      (bdMode === "on" || bdMode === "auto");

    if (bdMode === "off") {
      await dualLogInfo(
        "[Bright Data] OFF — BRIGHT_DATA_ENABLED=false; direct connection (proxy settings ignored).",
        { jobId, platform, sessionId: brightDataSessionId }
      );
    } else if (bdMode === "on" && (!bdHasProxyHost || !bdHasSession)) {
      await dualLogWarn(
        "[Bright Data] BRIGHT_DATA_ENABLED=true but BRIGHT_DATA_PROXY_HOST or session id is missing; cannot enable proxy.",
        {
          jobId,
          platform,
          hasProxyHost: bdHasProxyHost,
          hasSession: bdHasSession,
        }
      );
    }

    if (bdUseProxy && bdHasCredentials) {
      await dualLogInfo(
        "[Bright Data] ENABLED — proxy host, sticky session id, and credentials are set; browser traffic will route through Bright Data.",
        {
          jobId,
          platform,
          sessionId: brightDataSessionId,
          proxyHost: process.env.BRIGHT_DATA_PROXY_HOST,
          brightDataMode: bdMode,
        }
      );
    } else if (bdUseProxy && !bdHasCredentials) {
      await dualLogWarn(
        "[Bright Data] INCOMPLETE — proxy is active but BRIGHT_DATA_USERNAME or BRIGHT_DATA_PASSWORD is missing; proxy auth will not run.",
        { jobId, platform, sessionId: brightDataSessionId }
      );
    } else if (bdMode !== "off" && bdHasSession && !bdHasProxyHost) {
      await dualLogWarn(
        "[Bright Data] NOT ACTIVE — job has a session id but BRIGHT_DATA_PROXY_HOST is unset; using direct connection (no Bright Data proxy).",
        { jobId, platform, sessionId: brightDataSessionId }
      );
    } else if (!bdHasSession && bdMode !== "off") {
      await dualLogInfo(
        "[Bright Data] NOT USED — no sticky session id passed for this run (direct connection).",
        { jobId, platform }
      );
    }

    if (bdUseProxy) {
      const proxyHost = process.env.BRIGHT_DATA_PROXY_HOST;
      launchArgs.push(`--proxy-server=${proxyHost}`);
    }

    try {
      browser = (await puppeteerExtra.launch({
        headless: configs.headless_browser as any,
        defaultViewport: null,
        args: launchArgs,
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

    if (
      bdUseProxy &&
      process.env.BRIGHT_DATA_USERNAME &&
      process.env.BRIGHT_DATA_PASSWORD
    ) {
      const brightDataUsername = process.env.BRIGHT_DATA_USERNAME;
      const brightDataPassword = process.env.BRIGHT_DATA_PASSWORD;
      const countryCode = getBrightDataCountry(jobId || "");
      let proxyUsername = `${brightDataUsername}-session-${brightDataSessionId}`;
      if (countryCode) {
        proxyUsername += `-country-${countryCode}`;
      }
      await page.authenticate({
        username: proxyUsername,
        password: brightDataPassword,
      });
      await dualLogInfo(
        "[Bright Data] Proxy authentication applied (username includes session + country routing).",
        {
          jobId,
          sessionId: brightDataSessionId,
          platform,
          countryCode: countryCode || "auto",
        }
      );
    } else if (bdUseProxy && !bdHasCredentials) {
      await dualLogWarn(
        "[Bright Data] Skipping page.authenticate — set BRIGHT_DATA_USERNAME and BRIGHT_DATA_PASSWORD.",
        { jobId, platform }
      );
    }

    if (windowSize) {
      await page.setViewport({
        width: windowSize.width,
        height: windowSize.height,
      });
      await dualLogInfo(
        `Set viewport size: ${windowSize.width}x${windowSize.height}`,
        { jobId, windowSize }
      );
    } else {
      await page.setViewport({
        width: 1920,
        height: 1080,
        deviceScaleFactor: 1,
        hasTouch: false,
        isLandscape: true,
        isMobile: false,
      });
    }

    // Sync UA / client-hints with the *actual* bundled Chromium version.
    const rawUA = await browser.userAgent();
    const { userAgent, headers } = buildClientHintsFromUA(rawUA);
    await page.setUserAgent(userAgent);

    const finalHeaders = { ...headers };
    if (acceptLanguage) {
      finalHeaders["Accept-Language"] = acceptLanguage;
      await dualLogInfo(`Set Accept-Language: ${acceptLanguage}`, {
        jobId,
        acceptLanguage,
      });
    }
    await page.setExtraHTTPHeaders(finalHeaders);
    await dualLogInfo("Spoofed UA in sync with bundled Chromium", { userAgent });

    try {
      await page.emulateTimezone(timezone || "America/New_York");
    } catch {
      /* noop — timezone override can fail on some Chromium builds */
    }

    // Fingerprint hardening on top of stealth plugin.
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "hardwareConcurrency", {
        get: () => 8,
      });
      Object.defineProperty(navigator, "deviceMemory", {
        get: () => 8,
      });
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      });
      (window as any).chrome = (window as any).chrome || { runtime: {} };
    });

    await page.setDefaultNavigationTimeout(loadingTimeout);
    await page.setDefaultTimeout(selectorTimeout);

    if (bdUseProxy && bdHasCredentials) {
      try {
        await dualLogInfo(
          "[Bright Data] Verifying egress IP via ipify (through proxy).",
          { jobId, sessionId: brightDataSessionId }
        );
        const ipResponse = await page.goto(
          "https://api.ipify.org?format=json",
          { waitUntil: "networkidle0", timeout: 10000 }
        );
        if (ipResponse && ipResponse.ok()) {
          const ipData = (await ipResponse.json()) as { ip?: string };
          const ipAddress = ipData.ip;
          if (ipAddress) {
            try {
              const geoResponse = await page.goto(
                `https://ipapi.co/${ipAddress}/json/`,
                { waitUntil: "networkidle0", timeout: 10000 }
              );
              if (geoResponse && geoResponse.ok()) {
                const geoData = (await geoResponse.json()) as Record<string, string>;
                const country = geoData.country_name || geoData.country || "Unknown";
                const city = geoData.city || "Unknown";
                const region = geoData.region || "Unknown";
                await dualLogInfo(
                  `[Bright Data] VERIFIED — public egress IP: ${ipAddress} | ${country} | ${city}, ${region}`,
                  { jobId, sessionId: brightDataSessionId, ipAddress, country, brightDataEgressVerified: true }
                );
              } else {
                await dualLogInfo(
                  `[Bright Data] VERIFIED — public egress IP: ${ipAddress} (geo lookup failed).`,
                  { jobId, sessionId: brightDataSessionId, ipAddress }
                );
              }
            } catch {
              await dualLogInfo(
                `[Bright Data] VERIFIED — public egress IP: ${ipAddress} (geo lookup failed).`,
                { jobId, sessionId: brightDataSessionId, ipAddress }
              );
            }
          } else {
            await dualLogWarn("[Bright Data] IP check returned no address.", { jobId });
          }
        } else {
          await dualLogWarn("[Bright Data] IP check HTTP failed.", { jobId });
        }
      } catch (ipError: any) {
        await dualLogWarn(
          "[Bright Data] IP verification failed (non-critical). Proxy may still work.",
          { jobId, error: ipError.message }
        );
      }
    }

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
          const msg = String(navError?.message ?? navError);
          if (msg.includes("ERR_INVALID_AUTH_CREDENTIALS") && bdUseProxy) {
            await dualLogWarn(
              "Navigation failed with ERR_INVALID_AUTH_CREDENTIALS: verify BRIGHT_DATA_USERNAME / BRIGHT_DATA_PASSWORD.",
              { jobId, platform, attempt, error: msg }
            );
          }
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
      // ── Agoda path: direct navigation (unchanged) ──
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await dualLogInfo(`Navigation attempt ${attempt}/${maxRetries}`, {
            attempt,
            maxRetries,
          });

          await page.goto("https://ycs.agoda.com", {
            waitUntil: "domcontentloaded",
            timeout: loadingTimeout,
          });
          await page.waitForNavigation({ waitUntil: "networkidle0" });

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
