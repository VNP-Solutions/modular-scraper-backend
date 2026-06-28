import type { Page } from "puppeteer";

/** Chrome UA used consistently across Booking flows. */
export const BOOKING_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export const BOOKING_EXTRA_HTTP_HEADERS: Record<string, string> = {
  "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "max-age=0",
  "sec-ch-ua":
    '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  DNT: "1",
  "Upgrade-Insecure-Requests": "1",
};

/**
 * Runs in the page context before any Booking scripts (error tracker, FWCIM /
 * challenge.js). Based on analysis of booking-error-tracker and FWCIM collectors.
 */
export function injectBookingAntiDetection(): void {
  const w = window as any;
  const doc = document;

  // --- challenge.js / booking.env human flags ---
  doc.documentElement.className =
    doc.documentElement.className.replace(/\bnoJS\b/g, "").trim() + " hasJS";

  w.booking = w.booking || {};
  w.booking.env = w.booking.env || {};
  w.booking.env.b_agent_is_no_robot = true;
  w.booking.env.b_agent_is_robot = false;
  w.booking.env.b_site_type = w.booking.env.b_site_type || "www";
  w.booking.env.b_site_type_id = w.booking.env.b_site_type_id || "1";
  w.booking.env.b_lang = w.booking.env.b_lang || "en";
  w.booking.env.b_locale = w.booking.env.b_locale || "en-us";
  w.booking.env.b_lang_for_url = w.booking.env.b_lang_for_url || "en-us";
  w.booking.env.b_guest_country = w.booking.env.b_guest_country || "us";
  w.booking.env.isRetina = window.devicePixelRatio > 1;
  w.booking.user = w.booking.user || {};
  w.booking._onfly = w.booking._onfly || [];
  w.booking.devTools = w.booking.devTools || { trackedExperiments: [] };

  // --- error tracker bot flags ($u.b01, booking_extra.bot) ---
  const lockBotFlags = (): void => {
    w.$u = w.$u || {};
    w.$u.application = w.$u.application || { application: "web", tag: "default" };
    try {
      Object.defineProperty(w.$u, "b01", {
        get: () => false,
        set: () => {},
        configurable: true,
      });
    } catch {
      w.$u.b01 = false;
    }

    w.booking_extra = w.booking_extra || {};
    try {
      Object.defineProperty(w.booking_extra, "bot", {
        get: () => false,
        set: () => {},
        configurable: true,
      });
    } catch {
      w.booking_extra.bot = false;
    }
  };
  lockBotFlags();
  doc.addEventListener("DOMContentLoaded", lockBotFlags, { once: true });

  // Clear server-side error_catcher kill cookie if present
  const clearErrorCatcher = (): void => {
    const expired =
      "error_catcher=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/";
    doc.cookie = expired;
    doc.cookie = `${expired}; domain=.booking.com`;
    doc.cookie = `${expired}; domain=admin.booking.com`;
  };
  clearErrorCatcher();

  // Realistic page timing for error tracker PageLoadTimer
  const now = Date.now();
  w.PageLoadTimer = {
    start: now - 2000 - Math.floor(Math.random() * 500),
    document_ready: now - 1000 - Math.floor(Math.random() * 300),
    window_load: now - Math.floor(Math.random() * 200),
  };

  // --- AutomationDetectionCollector ---
  delete w.__webdriver_unwrapped;
  delete w.$cdc_asdjflasutopfhvcZLmcfl_;
  delete w.callPhantom;
  delete w._phantom;
  delete w.__nightmare;
  delete w.playwright;
  delete w.__playwright;

  Object.defineProperty(navigator, "webdriver", {
    get: () => false,
    configurable: true,
  });

  // --- StealthDetectionCollector / NavigatorPluginCollector ---
  Object.defineProperty(navigator, "plugins", {
    get: () => {
      const arr = [1, 2, 3, 4, 5] as unknown as PluginArray;
      return arr;
    },
    configurable: true,
  });

  Object.defineProperty(navigator, "languages", {
    get: () => ["en-US", "en", "en-GB"],
    configurable: true,
  });

  Object.defineProperty(navigator, "hardwareConcurrency", {
    get: () => 8,
    configurable: true,
  });

  Object.defineProperty(navigator, "deviceMemory", {
    get: () => 8,
    configurable: true,
  });

  // --- BatteryCollector ---
  const nav = navigator as Navigator & {
    getBattery?: () => Promise<{
      charging: boolean;
      chargingTime: number;
      dischargingTime: number;
      level: number;
      addEventListener: () => void;
      removeEventListener: () => void;
      dispatchEvent: () => boolean;
    }>;
  };
  if (nav.getBattery) {
    nav.getBattery = () =>
      Promise.resolve({
        charging: true,
        chargingTime: 0,
        dischargingTime: Infinity,
        level: 0.85,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      });
  }

  // --- ScreenInfoCollector ---
  Object.defineProperty(screen, "availWidth", { get: () => 1905, configurable: true });
  Object.defineProperty(screen, "availHeight", { get: () => 945, configurable: true });
  Object.defineProperty(screen, "width", { get: () => 1905, configurable: true });
  Object.defineProperty(screen, "height", { get: () => 945, configurable: true });
  Object.defineProperty(screen, "colorDepth", { get: () => 24, configurable: true });
  Object.defineProperty(screen, "pixelDepth", { get: () => 24, configurable: true });

  // --- HistoryCollector ---
  try {
    Object.defineProperty(window.history, "length", {
      get: () => 10 + Math.floor(Math.random() * 15),
      configurable: true,
    });
  } catch {
    // ignore
  }

  // --- ColorGamutCollector ---
  const origMatchMedia = window.matchMedia.bind(window);
  window.matchMedia = (query: string): MediaQueryList => {
    if (/color-gamut:\s*p3/i.test(query)) {
      return {
        matches: true,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      } as MediaQueryList;
    }
    return origMatchMedia(query);
  };

  // --- WebGLGPUCollector ---
  const patchWebGL = (Context: any): void => {
    if (!Context?.prototype?.getParameter) return;
    const origGetParameter = Context.prototype.getParameter;
    Context.prototype.getParameter = function (param: number) {
      if (param === 37445) return "Intel Inc.";
      if (param === 37446) return "Intel Iris OpenGL Engine";
      return origGetParameter.call(this, param);
    };
  };
  patchWebGL(w.WebGLRenderingContext);
  patchWebGL(w.WebGL2RenderingContext);

  // --- CanvasCollector ---
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (...args: unknown[]) {
    const result = origToDataURL.apply(this, args as [string?, number?]);
    return `${result}?${Math.random().toString(36).slice(2, 9)}`;
  };

  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function (...args: unknown[]) {
    const data = origGetImageData.apply(this, args as [number, number, number, number]);
    for (let i = 0; i < data.data.length; i += 4) {
      data.data[i] += Math.random() * 2 - 1;
      data.data[i + 1] += Math.random() * 2 - 1;
      data.data[i + 2] += Math.random() * 2 - 1;
    }
    return data;
  };

  // --- AudioFingerprintCollector ---
  const OriginalAudioContext = w.AudioContext || w.webkitAudioContext;
  if (OriginalAudioContext) {
    const PatchedAudioContext = function (this: AudioContext, ...args: unknown[]) {
      const ctx = new OriginalAudioContext(...args);
      const origCreateOscillator = ctx.createOscillator.bind(ctx);
      ctx.createOscillator = () => {
        const osc = origCreateOscillator();
        const origStart = osc.start.bind(osc);
        osc.start = (when?: number) =>
          origStart(when !== undefined ? when + Math.random() * 0.01 : when);
        return osc;
      };
      return ctx;
    };
    PatchedAudioContext.prototype = OriginalAudioContext.prototype;
    w.AudioContext = PatchedAudioContext;
    if (w.webkitAudioContext) w.webkitAudioContext = PatchedAudioContext;
  }

  // Chrome runtime stub (headless detection)
  w.chrome = w.chrome || {
    app: { isInstalled: false, InstallState: {}, RunningState: {} },
    runtime: {
      onMessage: { addListener: () => {}, removeListener: () => {} },
      connect: () => {},
      sendMessage: () => {},
    },
  };

  // Permissions — avoid Puppeteer's default "denied" for notifications probe
  const origQuery = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = (parameters: PermissionDescriptor) => {
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
    return origQuery(parameters);
  };

  // Connection info
  Object.defineProperty(navigator, "connection", {
    get: () => ({
      rtt: 50,
      downlink: 10,
      effectiveType: "4g",
      saveData: false,
    }),
    configurable: true,
  });
}

/**
 * Apply Booking.com anti-bot patches to a Puppeteer page before navigation.
 */
export async function applyBookingAntiDetection(page: Page): Promise<void> {
  await page.setUserAgent(BOOKING_USER_AGENT);
  await page.setExtraHTTPHeaders(BOOKING_EXTRA_HTTP_HEADERS);
  await page.evaluateOnNewDocument(injectBookingAntiDetection);
}
