import dotenv from "dotenv";
import puppeteer, { Browser, Page } from "puppeteer";
import { BROWSER_CONFIG } from "../common/browser-constants.js";
import { delay } from "../common/delay.js";
import {
  dualLogError,
  dualLogInfo,
  dualLogWarn,
} from "../common/log-helper.js";
import { timeoutManager } from "../common/timeout-manager.js";
import { configs } from "../config/index.js";
dotenv.config();

export async function browserSetupLocal(
  jobId?: string,
  platform?: "expedia" | "agoda",
  brightDataSessionId?: string,
  windowSize?: { width: number; height: number },
  timezone?: string, // Added for timezone spoofing
  acceptLanguage?: string // Added for Accept-Language header
): Promise<{
  browser: Browser;
  page: Page;
}> {
  let browser: Browser | null = null;

  try {
    // Prepare launch args
    const launchArgs = [...BROWSER_CONFIG.LAUNCH_ARGS];

    // Add window size if provided
    if (windowSize) {
      launchArgs.push(`--window-size=${windowSize.width},${windowSize.height}`);
    }

    // Add Bright Data proxy if session ID provided
    if (brightDataSessionId && process.env.BRIGHT_DATA_PROXY_HOST) {
      const proxyHost = process.env.BRIGHT_DATA_PROXY_HOST;
      launchArgs.push(`--proxy-server=${proxyHost}`);
      await dualLogInfo(
        `Using Bright Data proxy with session: ${brightDataSessionId}`,
        { jobId, proxyHost, windowSize }
      );
    }

    try {
      browser = await puppeteer.launch({
        headless: configs.headless_browser as any, // "new" headless mode supported by Puppeteer but not in type definitions
        defaultViewport: null,
        args: launchArgs,
      });
    } catch (error: any) {
      await dualLogError("Error launching browser:", error);
      // Send email notification for browser launch error
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

    // Get timeout configuration for this job
    const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);
    const selectorTimeout = await timeoutManager.getSelectorTimeout(jobId);

    const page: Page = await browser.newPage();

    // Authenticate with Bright Data if session ID provided
    if (
      brightDataSessionId &&
      process.env.BRIGHT_DATA_USERNAME &&
      process.env.BRIGHT_DATA_PASSWORD
    ) {
      const brightDataUsername = process.env.BRIGHT_DATA_USERNAME;
      const brightDataPassword = process.env.BRIGHT_DATA_PASSWORD;

      // Get country code for this job
      let countryCode: string | undefined;
      let countryName: string | undefined;
      try {
        const { getBrightDataCountry, getBrightDataCountryName } = await import(
          "../common/job-isolation.js"
        );
        countryCode = getBrightDataCountry(jobId || "");
        countryName = getBrightDataCountryName(jobId || "");
      } catch (error) {
        // Country selection is optional
      }

      // Bright Data format: username-session-{sessionId}-country-{code}
      let proxyUsername = `${brightDataUsername}-session-${brightDataSessionId}`;
      if (countryCode) {
        proxyUsername += `-country-${countryCode}`;
      }

      await page.authenticate({
        username: proxyUsername,
        password: brightDataPassword,
      });

      await dualLogInfo(`Authenticated with Bright Data proxy`, {
        jobId,
        sessionId: brightDataSessionId,
        proxyUsername,
        country: countryName || countryCode || "Auto",
        countryCode: countryCode || "auto",
      });
    }

    // Set viewport size if provided
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

    // Detect IP address and country if using Bright Data proxy
    if (brightDataSessionId) {
      try {
        await dualLogInfo("Detecting residential IP and location...", {
          jobId,
        });

        const ipResponse = await page.goto(
          "https://api.ipify.org?format=json",
          {
            waitUntil: "networkidle0",
            timeout: 10000,
          }
        );

        if (ipResponse && ipResponse.ok()) {
          const ipData = await ipResponse.json();
          const ipAddress = ipData.ip;

          // Get country/location info
          try {
            const geoResponse = await page.goto(
              `https://ipapi.co/${ipAddress}/json/`,
              { waitUntil: "networkidle0", timeout: 10000 }
            );

            if (geoResponse && geoResponse.ok()) {
              const geoData = await geoResponse.json();
              const country =
                geoData.country_name || geoData.country || "Unknown";
              const city = geoData.city || "Unknown";
              const region = geoData.region || "Unknown";

              await dualLogInfo(
                `✅ Bright Data Residential IP Detected: ${ipAddress} | Country: ${country} | City: ${city}, ${region}`,
                {
                  jobId,
                  sessionId: brightDataSessionId,
                  ipAddress,
                  country,
                  city,
                  region,
                  countryCode: geoData.country_code,
                  isp: geoData.org,
                }
              );
            } else {
              await dualLogInfo(
                `✅ Bright Data Residential IP Detected: ${ipAddress}`,
                { jobId, sessionId: brightDataSessionId, ipAddress }
              );
            }
          } catch (geoError) {
            await dualLogInfo(
              `✅ Bright Data Residential IP Detected: ${ipAddress} (Country detection failed)`,
              { jobId, sessionId: brightDataSessionId, ipAddress }
            );
          }
        }
      } catch (ipError: any) {
        await dualLogWarn("Failed to detect IP address (non-critical)", {
          jobId,
          error: ipError.message,
        });
      }
    }

    // Set timezone via CDP (Chrome DevTools Protocol)
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

    // Set user agent to match GraphQL API headers exactly
    await page.setUserAgent(BROWSER_CONFIG.USER_AGENT);

    // Set additional headers with country-specific Accept-Language
    const headers = { ...BROWSER_CONFIG.HEADERS };
    if (acceptLanguage) {
      headers["Accept-Language"] = acceptLanguage;
      await dualLogInfo(`Set Accept-Language: ${acceptLanguage}`, {
        jobId,
        acceptLanguage,
      });
    }
    await page.setExtraHTTPHeaders(headers);

    // Hide automation indicators and add anti-detection features
    await page.evaluateOnNewDocument(
      (config: { languages: string[] }) => {
        // Remove webdriver property
        delete (navigator as any).webdriver;

        // Override the plugins property to use a real value
        Object.defineProperty(navigator, "plugins", {
          get: () => [1, 2, 3, 4, 5],
        });

        // Override the languages property with country-specific languages
        Object.defineProperty(navigator, "languages", {
          get: () => config.languages,
        });

        // Override chrome property
        (window as any).chrome = {
          runtime: {},
        };

        // Mock permissions
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
      {
        languages: acceptLanguage
          ? acceptLanguage.split(",").map((l) => l.trim())
          : ["en-US", "en"],
      }
    );
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
          await page.goto("https://portal.agoda.com", {
            waitUntil: "domcontentloaded",
            timeout: loadingTimeout,
          });
          await page.waitForNavigation({ waitUntil: "networkidle0" });
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

      // Send email notification for navigation failure
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
