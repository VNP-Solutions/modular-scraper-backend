/**
 * Shared browser constants to ensure perfect synchronization
 * between Puppeteer browser fingerprint and API call headers.
 *
 * NOTE: The User-Agent / sec-ch-ua values below are *defaults* that will be
 * overwritten at runtime by `getRealisticHeaders()` (see browser-local.ts) so
 * they always match the actual bundled Chromium version. They are kept here
 * only so that GraphQL API calls made outside of a live browser context still
 * have a sensible value to fall back to.
 */

export const BROWSER_CONFIG = {
  // Fallback UA (runtime overrides this with the actual Chromium UA)
  USER_AGENT:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",

  // Generic navigation headers. `sec-ch-ua` is set dynamically at runtime.
  HEADERS: {
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Upgrade-Insecure-Requests": "1",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
  } as Record<string, string>,

  // GraphQL API specific headers (matching your working curl)
  GRAPHQL_HEADERS: {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/json",
    "client-name": "pc-reservations-web",
    origin: "https://apps.expediapartnercentral.com",
    priority: "u=1, i",
    referer: "https://apps.expediapartnercentral.com/",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
  } as Record<string, string>,

  /**
   * Chrome launch args.
   *
   * IMPORTANT — flags that were removed and why:
   *   --disable-web-security            (huge Akamai red flag; real users never have this)
   *   --disable-features=IsolateOrigins,site-per-process (same reason)
   *   --excludeSwitches=enable-automation (invalid Chrome flag, Selenium-only)
   *   --disable-automation              (not a real Chrome flag)
   *   --disable-gpu                     (headed Chrome has GPU enabled; flagging bot)
   *   --disable-extensions              (real Chrome has some extensions; harmless to leave on)
   */
  LAUNCH_ARGS: [
    "--start-maximized",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=TranslateUI,BlockInsecurePrivateNetworkRequests",
    "--disable-ipc-flooding-protection",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-pings",
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-infobars",
    "--window-size=1920,1080",
  ],
};

/**
 * Build a realistic set of request headers from the *actual* Chromium UA the
 * browser is running.
 *
 * IMPORTANT: Expedia / Akamai flags Linux UAs extremely aggressively because
 * very few real Expedia Partner Central users are on Linux desktop. So even
 * when this code runs on an Ubuntu server, we rewrite the UA to claim macOS.
 * The major Chrome version is still taken from the real bundled Chromium so
 * UA <-> JS runtime behavior stays consistent.
 *
 * You can opt out by setting `SPOOF_PLATFORM=native` in the environment.
 */
export function buildClientHintsFromUA(ua: string): {
  userAgent: string;
  headers: Record<string, string>;
} {
  const cleanUA = ua.replace(/HeadlessChrome/g, "Chrome");
  const majorMatch = cleanUA.match(/Chrome\/(\d+(?:\.\d+){0,3})/);
  const fullVersion = majorMatch ? majorMatch[1] : "140.0.0.0";
  const major = fullVersion.split(".")[0];

  const spoofPlatform = (process.env.SPOOF_PLATFORM || "macos").toLowerCase();

  let userAgent: string;
  let platformHeader: string;

  if (spoofPlatform === "native") {
    userAgent = cleanUA;
    if (/Macintosh|Mac OS X/.test(cleanUA)) platformHeader = '"macOS"';
    else if (/Windows/.test(cleanUA)) platformHeader = '"Windows"';
    else platformHeader = '"Linux"';
  } else if (spoofPlatform === "windows") {
    userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fullVersion} Safari/537.36`;
    platformHeader = '"Windows"';
  } else {
    // default: macOS
    userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fullVersion} Safari/537.36`;
    platformHeader = '"macOS"';
  }

  const secChUa = `"Chromium";v="${major}", "Not;A=Brand";v="24", "Google Chrome";v="${major}"`;

  return {
    userAgent,
    headers: {
      ...BROWSER_CONFIG.HEADERS,
      "sec-ch-ua": secChUa,
      "sec-ch-ua-platform": platformHeader,
    },
  };
}
