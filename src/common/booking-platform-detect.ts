import type { Page } from "puppeteer";
import type { BrowserPlatform } from "./booking-platform-profiles.js";

/** OS where the Node scraper process is running. */
export function detectHostPlatform(): BrowserPlatform {
  switch (process.platform) {
    case "darwin":
      return "mac";
    case "win32":
      return "win";
    default:
      return "linux";
  }
}

function platformFromUserAgentSnapshot(snapshot: {
  ua: string;
  platform: string;
}): BrowserPlatform | null {
  if (/Windows/i.test(snapshot.ua) || snapshot.platform === "Win32") {
    return "win";
  }
  if (/Macintosh|Mac OS X/i.test(snapshot.ua) || snapshot.platform === "MacIntel") {
    return "mac";
  }
  if (/Linux/i.test(snapshot.ua) || /Linux/i.test(snapshot.platform)) {
    return "linux";
  }
  return null;
}

/**
 * Detect the OS of the connected Chrome instance (before anti-detection patches).
 * This reflects the actual browser environment — e.g. Browserless Linux vs local Mac.
 */
export async function detectBrowserPlatform(page: Page): Promise<BrowserPlatform> {
  try {
    const currentUrl = page.url();
    if (!currentUrl || currentUrl === "about:blank") {
      await page.goto("about:blank", { waitUntil: "load", timeout: 10000 });
    }

    const snapshot = await page.evaluate(() => ({
      ua: navigator.userAgent,
      platform: navigator.platform,
    }));

    const fromBrowser = platformFromUserAgentSnapshot(snapshot);
    if (fromBrowser) return fromBrowser;
  } catch {
    // fall through to host detection
  }

  return detectHostPlatform();
}

/**
 * Resolve which platform profile to use.
 *
 * BROWSER_PROFILE_PLATFORM:
 * - auto (default): detect from browser, fallback to host OS
 * - host: always use Node host OS (Mac/Win/Linux where scraper runs)
 * - mac | win | linux: force a specific profile
 */
export async function resolveBrowserPlatform(page: Page): Promise<{
  platform: BrowserPlatform;
  source: "env" | "browser" | "host";
}> {
  const env = process.env.BROWSER_PROFILE_PLATFORM?.trim().toLowerCase();

  if (env === "mac" || env === "win" || env === "linux") {
    return { platform: env, source: "env" };
  }

  if (env === "host") {
    return { platform: detectHostPlatform(), source: "host" };
  }

  try {
    const currentUrl = page.url();
    if (!currentUrl || currentUrl === "about:blank") {
      await page.goto("about:blank", { waitUntil: "load", timeout: 10000 });
    }

    const snapshot = await page.evaluate(() => ({
      ua: navigator.userAgent,
      platform: navigator.platform,
    }));

    const fromBrowser = platformFromUserAgentSnapshot(snapshot);
    if (fromBrowser) {
      return { platform: fromBrowser, source: "browser" };
    }
  } catch {
    // fall through
  }

  return { platform: detectHostPlatform(), source: "host" };
}
