import dotenv from "dotenv";
import puppeteer, { Browser, Page } from "puppeteer";
import { BROWSER_CONFIG } from "../common/browser-constants.js";
import { delay } from "../common/delay.js";
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

    if (bdHasSession && bdHasProxyHost && bdHasCredentials) {
      await dualLogInfo(
        "[Bright Data] ENABLED — proxy host, sticky session id, and credentials are set; browser traffic will route through Bright Data.",
        {
          jobId,
          platform,
          sessionId: brightDataSessionId,
          proxyHost: process.env.BRIGHT_DATA_PROXY_HOST,
        }
      );
    } else if (bdHasSession && bdHasProxyHost && !bdHasCredentials) {
      await dualLogWarn(
        "[Bright Data] INCOMPLETE — BRIGHT_DATA_PROXY_HOST is set but BRIGHT_DATA_USERNAME or BRIGHT_DATA_PASSWORD is missing; proxy auth will not run.",
        { jobId, platform, sessionId: brightDataSessionId }
      );
    } else if (bdHasSession && !bdHasProxyHost) {
      await dualLogWarn(
        "[Bright Data] NOT ACTIVE — job has a session id but BRIGHT_DATA_PROXY_HOST is unset; using direct connection (no Bright Data proxy).",
        { jobId, platform, sessionId: brightDataSessionId }
      );
    } else if (!bdHasSession) {
      await dualLogInfo(
        "[Bright Data] NOT USED — no sticky session id passed for this run (direct connection).",
        { jobId, platform }
      );
    }

    if (brightDataSessionId && process.env.BRIGHT_DATA_PROXY_HOST) {
      const proxyHost = process.env.BRIGHT_DATA_PROXY_HOST;
      launchArgs.push(`--proxy-server=${proxyHost}`);
    }

    try {
      browser = await puppeteer.launch({
        headless: configs.headless_browser as any,
        defaultViewport: null,
        args: launchArgs,
      });
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
      brightDataSessionId &&
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
    } else if (brightDataSessionId && bdHasProxyHost && !bdHasCredentials) {
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
    }

    if (brightDataSessionId && bdHasProxyHost && bdHasCredentials) {
      try {
        await dualLogInfo(
          "[Bright Data] Verifying egress IP via ipify (through proxy) — compare this IP with your Bright Data session if needed.",
          { jobId, sessionId: brightDataSessionId }
        );
        const ipResponse = await page.goto(
          "https://api.ipify.org?format=json",
          {
            waitUntil: "networkidle0",
            timeout: 10000,
          }
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
                const geoData = (await geoResponse.json()) as Record<
                  string,
                  string
                >;
                const country =
                  geoData.country_name || geoData.country || "Unknown";
                const city = geoData.city || "Unknown";
                const region = geoData.region || "Unknown";
                await dualLogInfo(
                  `[Bright Data] VERIFIED — public egress IP: ${ipAddress} | ${country} | ${city}, ${region} (this is the IP sites see for this browser).`,
                  {
                    jobId,
                    sessionId: brightDataSessionId,
                    ipAddress,
                    country,
                    brightDataEgressVerified: true,
                  }
                );
              } else {
                await dualLogInfo(
                  `[Bright Data] VERIFIED — public egress IP: ${ipAddress} (geo lookup failed; proxy still likely OK).`,
                  {
                    jobId,
                    sessionId: brightDataSessionId,
                    ipAddress,
                    brightDataEgressVerified: true,
                  }
                );
              }
            } catch {
              await dualLogInfo(
                `[Bright Data] VERIFIED — public egress IP: ${ipAddress} (geo lookup failed; proxy still likely OK).`,
                {
                  jobId,
                  sessionId: brightDataSessionId,
                  ipAddress,
                  brightDataEgressVerified: true,
                }
              );
            }
          } else {
            await dualLogWarn(
              "[Bright Data] IP check returned no address — compare logs with Bright Data dashboard if unsure.",
              { jobId }
            );
          }
        } else {
          await dualLogWarn(
            "[Bright Data] IP check HTTP failed — cannot confirm egress IP from ipify.",
            { jobId }
          );
        }
      } catch (ipError: any) {
        await dualLogWarn(
          "[Bright Data] IP verification failed (non-critical). Proxy may still work; check error and Bright Data dashboard.",
          {
            jobId,
            error: ipError.message,
            hadProxyConfigured: bdHasProxyHost && bdHasCredentials,
          }
        );
      }
    }

    if (timezone) {
      try {
        const cdp = await page.target().createCDPSession();
        await cdp.send("Emulation.setTimezoneOverride", {
          timezoneId: timezone,
        });
        await dualLogInfo(`Set timezone: ${timezone}`, { jobId, timezone });
      } catch (timezoneError: any) {
        await dualLogWarn("Failed to set timezone (non-critical)", {
          jobId,
          error: timezoneError.message,
        });
      }
    }

    await page.setUserAgent(BROWSER_CONFIG.USER_AGENT);

    const headers = { ...BROWSER_CONFIG.HEADERS };
    if (acceptLanguage) {
      headers["Accept-Language"] = acceptLanguage;
      await dualLogInfo(`Set Accept-Language: ${acceptLanguage}`, {
        jobId,
        acceptLanguage,
      });
    }
    await page.setExtraHTTPHeaders(headers);

    const languageList = acceptLanguage
      ? acceptLanguage.split(",").map((l) => l.trim().split(";")[0])
      : ["en-US", "en"];

    await page.evaluateOnNewDocument(
      (config: { languages: string[] }) => {
        delete (navigator as any).webdriver;
        Object.defineProperty(navigator, "plugins", {
          get: () => [1, 2, 3, 4, 5],
        });
        Object.defineProperty(navigator, "languages", {
          get: () => config.languages,
        });
        (window as any).chrome = {
          runtime: {},
        };
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => {
          if (parameters.name === "notifications") {
            return Promise.resolve({
              state: Notification.permission,
              name: "notifications",
              onchange: null,
              addEventListener: () => {},
              removeEventListener: () => {},
              dispatchEvent: () => false,
            } as PermissionStatus);
          }
          return originalQuery(parameters);
        };
      },
      { languages: languageList }
    );

    await page.setDefaultNavigationTimeout(loadingTimeout);
    await page.setDefaultTimeout(selectorTimeout);

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
          await page.goto("https://ycs.agoda.com", {
            waitUntil: "domcontentloaded",
            timeout: loadingTimeout,
          });
          await page.waitForNavigation({ waitUntil: "networkidle0" });
        } else {
          await page.goto(
            "https://www.expediapartnercentral.com/Account/Logon?signedOff=true",
            {
              waitUntil: "domcontentloaded",
              timeout: loadingTimeout,
            }
          );
        }

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
