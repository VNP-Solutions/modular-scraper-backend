import type { Page } from "puppeteer";
import { resolveBrowserGeo, type BrowserGeoInfo } from "./booking-ip-geo.js";
import {
  detectHostPlatform,
  resolveBrowserPlatform,
} from "./booking-platform-detect.js";
import {
  PLATFORM_TEMPLATES,
  type BrowserPlatform,
} from "./booking-platform-profiles.js";

export type { BrowserGeoInfo } from "./booking-ip-geo.js";
export type { BrowserPlatform } from "./booking-platform-profiles.js";
export { detectHostPlatform, resolveBrowserPlatform } from "./booking-platform-detect.js";

/** Serializable browser profile — all fingerprint fields stay internally consistent. */
export interface BookingBrowserProfile {
  sessionSeed: number;
  browserPlatform: BrowserPlatform;
  userAgent: string;
  acceptLanguage: string;
  languages: string[];
  locale: string;
  lang: string;
  guestCountry: string;
  timezone: string;
  detectedIp?: string;
  detectedCountryCode?: string;
  platform: string;
  secChUaPlatform: string;
  uaDataPlatform: string;
  screenWidth: number;
  screenHeight: number;
  screenAvailWidth: number;
  screenAvailHeight: number;
  colorDepth: number;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  hardwareConcurrency: number;
  deviceMemory: number;
  webglVendor: string;
  webglRenderer: string;
  uaArchitecture: "x86" | "arm";
  platformVersion: string;
  connectionRtt: number;
  connectionDownlink: number;
  connectionEffectiveType: "slow-2g" | "2g" | "3g" | "4g";
  connectionType: "wifi" | "ethernet";
  historyLength: number;
  pageLoadStartOffset: number;
  pageLoadDomOffset: number;
  pageLoadWindowOffset: number;
  prefersDarkMode: boolean;
  batteryLevel: number;
  batteryCharging: boolean;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildConnectionMetrics(
  connectionType: "wifi" | "ethernet",
  rand: () => number
): {
  connectionRtt: number;
  connectionDownlink: number;
  connectionEffectiveType: "slow-2g" | "2g" | "3g" | "4g";
  connectionType: "wifi" | "ethernet";
} {
  if (connectionType === "ethernet") {
    return {
      connectionType: "ethernet",
      connectionEffectiveType: "4g",
      connectionRtt: 5 + Math.floor(rand() * 10),
      connectionDownlink: 35 + Math.floor(rand() * 65),
    };
  }

  return {
    connectionType: "wifi",
    connectionEffectiveType: rand() > 0.92 ? "3g" : "4g",
    connectionRtt: 20 + Math.floor(rand() * 30),
    connectionDownlink: 10 + Math.floor(rand() * 40),
  };
}

/**
 * Build a coherent Chrome profile for macOS, Windows, or Linux.
 * Platform can come from auto-detection, host OS, or BROWSER_PROFILE_PLATFORM env.
 */
export function createBookingBrowserProfile(
  seed?: number,
  geo?: BrowserGeoInfo,
  browserPlatform: BrowserPlatform = detectHostPlatform()
): BookingBrowserProfile {
  const sessionSeed = seed ?? Math.floor(Math.random() * 0x7fffffff);
  const rand = mulberry32(sessionSeed);
  const template = PLATFORM_TEMPLATES[browserPlatform];
  const hardware =
    template.hardwareProfiles[
      sessionSeed % template.hardwareProfiles.length
    ]!;

  const localeDefaults = geo ?? {
    acceptLanguage: "en-GB,en-US;q=0.9,en;q=0.8",
    languages: ["en-GB", "en-US", "en"],
    locale: "en-gb",
    lang: "en",
    guestCountry: "gb",
    timezone: "Europe/London",
  };

  const connection = buildConnectionMetrics(hardware.connectionType, rand);

  return {
    sessionSeed,
    browserPlatform,
    userAgent: template.userAgent,
    acceptLanguage: localeDefaults.acceptLanguage,
    languages: [...localeDefaults.languages],
    locale: localeDefaults.locale,
    lang: localeDefaults.lang,
    guestCountry: localeDefaults.guestCountry,
    timezone: localeDefaults.timezone,
    detectedIp: geo?.ip,
    detectedCountryCode: geo?.countryCode,
    platform: template.navigatorPlatform,
    secChUaPlatform: template.secChUaPlatform,
    uaDataPlatform: template.uaDataPlatform,
    screenWidth: hardware.screenWidth,
    screenHeight: hardware.screenHeight,
    screenAvailWidth: hardware.screenWidth,
    screenAvailHeight: hardware.screenAvailHeight,
    colorDepth: 24,
    viewportWidth: hardware.viewportWidth,
    viewportHeight: hardware.viewportHeight,
    devicePixelRatio: hardware.devicePixelRatio,
    hardwareConcurrency: hardware.hardwareConcurrency,
    deviceMemory: hardware.deviceMemory,
    webglVendor: hardware.webglVendor,
    webglRenderer: hardware.webglRenderer,
    uaArchitecture: hardware.uaArchitecture,
    platformVersion: template.platformVersion,
    ...connection,
    historyLength: 2 + Math.floor(rand() * 8),
    pageLoadStartOffset: 1800 + Math.floor(rand() * 700),
    pageLoadDomOffset: 900 + Math.floor(rand() * 400),
    pageLoadWindowOffset: 100 + Math.floor(rand() * 250),
    prefersDarkMode: rand() > 0.7,
    batteryLevel: 0.55 + rand() * 0.4,
    batteryCharging: rand() > 0.6,
  };
}

const DEFAULT_PROFILE = createBookingBrowserProfile(
  0xb00c1a9,
  undefined,
  detectHostPlatform()
);

export const BOOKING_USER_AGENT = DEFAULT_PROFILE.userAgent;

export const BOOKING_VIEWPORT = {
  width: DEFAULT_PROFILE.viewportWidth,
  height: DEFAULT_PROFILE.viewportHeight,
  deviceScaleFactor: DEFAULT_PROFILE.devicePixelRatio,
} as const;

export const BOOKING_EXTRA_HTTP_HEADERS: Record<string, string> = {
  "Accept-Language": DEFAULT_PROFILE.acceptLanguage,
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "max-age=0",
  "sec-ch-ua":
    '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
  "sec-ch-ua-mobile": "?0",
  DNT: "1",
  "Upgrade-Insecure-Requests": "1",
};

function profileHeaders(profile: BookingBrowserProfile): Record<string, string> {
  return {
    ...BOOKING_EXTRA_HTTP_HEADERS,
    "Accept-Language": profile.acceptLanguage,
    "sec-ch-ua-platform": profile.secChUaPlatform,
  };
}

const ERROR_CATCHER_DOMAINS = [
  "booking.com",
  ".booking.com",
  "admin.booking.com",
  ".admin.booking.com",
] as const;

async function clearErrorCatcherCookies(page: Page): Promise<void> {
  try {
    const client = await page.createCDPSession();
    for (const domain of ERROR_CATCHER_DOMAINS) {
      await client.send("Network.deleteCookies", {
        name: "error_catcher",
        domain,
      });
    }
  } catch {
    // CDP may be unavailable before first navigation
  }
}

/**
 * Runs in the page context before any Booking scripts (error tracker, FWCIM /
 * challenge.js). Receives a pre-built profile so UA, screen, WebGL, locale, etc.
 * stay internally consistent for the lifetime of the page.
 */
export function injectBookingAntiDetection(profile: BookingBrowserProfile): void {
  const w = window as typeof window & Record<string, unknown>;
  const doc = document;
  const sessionSeed = profile.sessionSeed;

  const makeNative = <T extends (...args: never[]) => unknown>(
    fn: T,
    name: string
  ): T => {
    const nativeStr = `function ${name}() { [native code] }`;
    Object.defineProperty(fn, "toString", {
      value: () => nativeStr,
      writable: false,
      configurable: true,
    });
    return fn;
  };

  const defineGetter = <T>(obj: object, key: string, value: T): void => {
    try {
      Object.defineProperty(obj, key, {
        get: makeNative(() => value, `get ${key}`),
        configurable: true,
      });
    } catch {
      // ignore read-only properties
    }
  };

  const canvasPixelOffset = (pixelIndex: number): number =>
    ((sessionSeed * 2654435761 + pixelIndex) >>> 0) % 5 - 2;

  const applyDeterministicCanvasNoise = (imageData: ImageData): void => {
    const { data } = imageData;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.min(255, Math.max(0, data[i]! + canvasPixelOffset(i)));
      data[i + 1] = Math.min(
        255,
        Math.max(0, data[i + 1]! + canvasPixelOffset(i + 1))
      );
      data[i + 2] = Math.min(
        255,
        Math.max(0, data[i + 2]! + canvasPixelOffset(i + 2))
      );
    }
  };

  const buildNoisyCanvasCopy = (source: HTMLCanvasElement): HTMLCanvasElement | null => {
    if (source.width <= 0 || source.height <= 0) return null;
    const copy = doc.createElement("canvas");
    copy.width = source.width;
    copy.height = source.height;
    const copyCtx = copy.getContext("2d");
    if (!copyCtx) return null;
    copyCtx.drawImage(source, 0, 0);
    const imageData = copyCtx.getImageData(0, 0, copy.width, copy.height);
    applyDeterministicCanvasNoise(imageData);
    copyCtx.putImageData(imageData, 0, 0);
    return copy;
  };

  const createPluginMimeArrays = (): {
    plugins: PluginArray;
    mimeTypes: MimeTypeArray;
  } => {
    type MutablePlugin = Plugin & Record<number, MimeType | undefined>;
    const pluginsData = [
      {
        name: "PDF Viewer",
        filename: "internal-pdf-viewer",
        description: "Portable Document Format",
      },
      {
        name: "Chrome PDF Viewer",
        filename: "internal-pdf-viewer",
        description: "",
      },
      {
        name: "Chromium PDF Viewer",
        filename: "internal-pdf-viewer",
        description: "",
      },
      {
        name: "Microsoft Edge PDF Viewer",
        filename: "internal-pdf-viewer",
        description: "",
      },
      {
        name: "WebKit built-in PDF",
        filename: "internal-pdf-viewer",
        description: "",
      },
    ];

    const mimeTypeEntries: MimeType[] = [];

    const pluginEntries = pluginsData.map((pluginData) => {
      const mimeType = {
        type: "application/pdf",
        suffixes: "pdf",
        description: "Portable Document Format",
        enabledPlugin: null as unknown as Plugin,
      } as MimeType;

      const plugin = {
        ...pluginData,
        length: 1,
        0: mimeType,
        item: (i: number) => (i === 0 ? mimeType : null),
        namedItem: (name: string) => (name === mimeType.type ? mimeType : null),
      } as unknown as MutablePlugin;

      Object.defineProperty(mimeType, "enabledPlugin", {
        get: () => plugin,
        configurable: true,
      });

      if (!mimeTypeEntries.some((entry) => entry.type === mimeType.type)) {
        mimeTypeEntries.push(mimeType);
      }

      return plugin;
    });

    const pluginArray = {
      length: pluginEntries.length,
      item: (i: number) => pluginEntries[i] ?? null,
      namedItem: (name: string) =>
        pluginEntries.find((p) => p.name === name) ?? null,
      refresh: () => {},
    } as unknown as PluginArray;

    pluginEntries.forEach((plugin, i) => {
      Object.defineProperty(pluginArray, String(i), {
        value: plugin,
        enumerable: true,
        configurable: true,
      });
    });
    Object.defineProperty(pluginArray, Symbol.iterator, {
      value: function* () {
        for (const plugin of pluginEntries) {
          yield plugin;
        }
      },
      configurable: true,
    });
    Object.setPrototypeOf(pluginArray, PluginArray.prototype);

    const mimeTypeArray = {
      length: mimeTypeEntries.length,
      item: (i: number) => mimeTypeEntries[i] ?? null,
      namedItem: (name: string) =>
        mimeTypeEntries.find((m) => m.type === name) ?? null,
    } as unknown as MimeTypeArray;

    mimeTypeEntries.forEach((mimeType, i) => {
      Object.defineProperty(mimeTypeArray, String(i), {
        value: mimeType,
        enumerable: true,
        configurable: true,
      });
    });
    Object.defineProperty(mimeTypeArray, Symbol.iterator, {
      value: function* () {
        for (const mimeType of mimeTypeEntries) {
          yield mimeType;
        }
      },
      configurable: true,
    });
    Object.setPrototypeOf(mimeTypeArray, MimeTypeArray.prototype);

    return { plugins: pluginArray, mimeTypes: mimeTypeArray };
  };

  const { plugins: cachedPluginArray, mimeTypes: cachedMimeTypeArray } =
    createPluginMimeArrays();

  const syncPageLoadTimer = (): void => {
    const timing = performance.timing;
    if (timing?.navigationStart > 0) {
      w.PageLoadTimer = {
        start: timing.navigationStart,
        document_ready:
          timing.domContentLoadedEventEnd || timing.domInteractive || Date.now(),
        window_load: timing.loadEventEnd || Date.now(),
      };
      return;
    }

    const now = Date.now();
    w.PageLoadTimer = {
      start: now - profile.pageLoadStartOffset,
      document_ready: now - profile.pageLoadDomOffset,
      window_load: now - profile.pageLoadWindowOffset,
    };
  };

  // --- challenge.js / booking.env human flags ---
  doc.documentElement.className =
    doc.documentElement.className.replace(/\bnoJS\b/g, "").trim() + " hasJS";

  w.booking = (w.booking as Record<string, unknown>) || {};
  const booking = w.booking as Record<string, unknown>;
  booking.env = (booking.env as Record<string, unknown>) || {};
  const env = booking.env as Record<string, unknown>;
  env.b_agent_is_no_robot = true;
  env.b_agent_is_robot = false;
  env.b_site_type = env.b_site_type || "www";
  env.b_site_type_id = env.b_site_type_id || "1";
  env.b_lang = env.b_lang || profile.lang;
  env.b_locale = env.b_locale || profile.locale;
  env.b_lang_for_url = env.b_lang_for_url || profile.locale;
  env.b_guest_country = env.b_guest_country || profile.guestCountry;
  env.isRetina = profile.devicePixelRatio > 1;
  booking.user = booking.user || {};
  booking._onfly = booking._onfly || [];
  booking.devTools = booking.devTools || { trackedExperiments: [] };

  // --- error tracker bot flags ($u.b01, booking_extra.bot) ---
  const lockBotFlags = (): void => {
    w.$u = (w.$u as Record<string, unknown>) || {};
    const u = w.$u as Record<string, unknown>;
    u.application = u.application || { application: "web", tag: "default" };
    try {
      Object.defineProperty(u, "b01", {
        get: () => false,
        set: () => {},
        configurable: true,
      });
    } catch {
      u.b01 = false;
    }

    w.booking_extra = (w.booking_extra as Record<string, unknown>) || {};
    const bookingExtra = w.booking_extra as Record<string, unknown>;
    try {
      Object.defineProperty(bookingExtra, "bot", {
        get: () => false,
        set: () => {},
        configurable: true,
      });
    } catch {
      bookingExtra.bot = false;
    }
  };
  lockBotFlags();
  doc.addEventListener("DOMContentLoaded", lockBotFlags, { once: true });

  // Clear non-HttpOnly error_catcher cookie if present (HttpOnly handled via CDP)
  const clearErrorCatcher = (): void => {
    const expired =
      "error_catcher=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/";
    doc.cookie = expired;
    doc.cookie = `${expired}; domain=.booking.com`;
    doc.cookie = `${expired}; domain=admin.booking.com`;
  };
  clearErrorCatcher();

  syncPageLoadTimer();
  doc.addEventListener("DOMContentLoaded", syncPageLoadTimer, { once: true });
  w.addEventListener("load", syncPageLoadTimer, { once: true });

  // --- AutomationDetectionCollector ---
  delete w.__webdriver_unwrapped;
  delete w.$cdc_asdjflasutopfhvcZLmcfl_;
  delete w.callPhantom;
  delete w._phantom;
  delete w.__nightmare;
  delete w.playwright;
  delete w.__playwright;

  defineGetter(navigator, "webdriver", false);

  // --- Navigator — patch only what must align with the chosen platform profile ---
  defineGetter(navigator, "platform", profile.platform);
  defineGetter(navigator, "languages", profile.languages);
  defineGetter(navigator, "language", profile.languages[0] ?? "en-GB");
  defineGetter(navigator, "hardwareConcurrency", profile.hardwareConcurrency);
  defineGetter(navigator, "deviceMemory", profile.deviceMemory);
  defineGetter(navigator, "plugins", cachedPluginArray);
  defineGetter(navigator, "mimeTypes", cachedMimeTypeArray);
  defineGetter(navigator, "vendor", "Google Inc.");
  defineGetter(navigator, "vendorSub", "");
  defineGetter(navigator, "maxTouchPoints", 0);
  defineGetter(navigator, "pdfViewerEnabled", true);

  const navWithUaData = navigator as Navigator & {
    userAgentData?: {
      brands: Array<{ brand: string; version: string }>;
      mobile: boolean;
      platform: string;
      getHighEntropyValues: (hints: string[]) => Promise<Record<string, unknown>>;
    };
  };

  if (navWithUaData.userAgentData) {
    defineGetter(navWithUaData, "userAgentData", {
      brands: [
        { brand: "Chromium", version: "140" },
        { brand: "Not=A?Brand", version: "24" },
        { brand: "Google Chrome", version: "140" },
      ],
      mobile: false,
      platform: profile.uaDataPlatform,
      getHighEntropyValues: makeNative(
        () =>
          Promise.resolve({
            architecture: profile.uaArchitecture,
            bitness: "64",
            model: "",
            platform: profile.uaDataPlatform,
            platformVersion: profile.platformVersion,
            uaFullVersion: "140.0.0.0",
            fullVersionList: [
              { brand: "Chromium", version: "140.0.0.0" },
              { brand: "Not=A?Brand", version: "24.0.0.0" },
              { brand: "Google Chrome", version: "140.0.0.0" },
            ],
          }),
        "getHighEntropyValues"
      ),
    });
  }

  // --- BatteryCollector — only override when API already exists ---
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
    nav.getBattery = makeNative(
      () =>
        Promise.resolve({
          charging: profile.batteryCharging,
          chargingTime: profile.batteryCharging ? 0 : Infinity,
          dischargingTime: profile.batteryCharging ? Infinity : 3600,
          level: profile.batteryLevel,
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }),
      "getBattery"
    );
  }

  // --- ScreenInfoCollector — physical display; viewport left to Puppeteer ---
  defineGetter(screen, "width", profile.screenWidth);
  defineGetter(screen, "height", profile.screenHeight);
  defineGetter(screen, "availWidth", profile.screenAvailWidth);
  defineGetter(screen, "availHeight", profile.screenAvailHeight);
  defineGetter(screen, "colorDepth", profile.colorDepth);
  defineGetter(screen, "pixelDepth", profile.colorDepth);

  // --- HistoryCollector — stable for the page lifetime ---
  try {
    Object.defineProperty(window.history, "length", {
      get: makeNative(() => profile.historyLength, "length"),
      configurable: true,
    });
  } catch {
    // ignore
  }

  // --- matchMedia (ColorGamutCollector + common probes) ---
  const origMatchMedia = window.matchMedia.bind(window);
  const mediaQueryMatches = (query: string): boolean | null => {
    const normalized = query.trim().toLowerCase();
    if (/color-gamut:\s*p3/i.test(normalized)) return true;
    if (/color-gamut:\s*srgb/i.test(normalized)) return true;
    if (/color-gamut:\s*rec2020/i.test(normalized)) return false;
    if (/prefers-color-scheme:\s*dark/i.test(normalized)) {
      return profile.prefersDarkMode;
    }
    if (/prefers-color-scheme:\s*light/i.test(normalized)) {
      return !profile.prefersDarkMode;
    }
    if (/prefers-reduced-motion:\s*reduce/i.test(normalized)) return false;
    if (/prefers-reduced-motion:\s*no-preference/i.test(normalized)) return true;
    if (/\(pointer:\s*fine\)/i.test(normalized)) return true;
    if (/\(pointer:\s*coarse\)/i.test(normalized)) return false;
    if (/\(hover:\s*hover\)/i.test(normalized)) return true;
    if (/\(hover:\s*none\)/i.test(normalized)) return false;
    if (/dynamic-range:\s*high/i.test(normalized)) return false;
    if (/dynamic-range:\s*standard/i.test(normalized)) return true;
    if (/display-mode:\s*browser/i.test(normalized)) return true;
    if (/display-mode:\s*standalone/i.test(normalized)) return false;
    return null;
  };

  const buildMediaQueryList = (query: string, matches: boolean): MediaQueryList =>
    ({
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;

  window.matchMedia = makeNative((query: string): MediaQueryList => {
    const override = mediaQueryMatches(query);
    if (override !== null) {
      return buildMediaQueryList(query, override);
    }
    return origMatchMedia(query);
  }, "matchMedia");

  // --- WebGLGPUCollector ---
  const patchWebGL = (Context: typeof WebGLRenderingContext | undefined): void => {
    if (!Context?.prototype?.getParameter) return;
    const origGetParameter = Context.prototype.getParameter;
    Context.prototype.getParameter = makeNative(function (
      this: WebGLRenderingContext,
      param: number
    ) {
      if (param === 37445) return profile.webglVendor;
      if (param === 37446) return profile.webglRenderer;
      return origGetParameter.call(this, param);
    }, "getParameter");
  };
  patchWebGL(w.WebGLRenderingContext);
  patchWebGL(w.WebGL2RenderingContext);

  // --- CanvasCollector — deterministic noise on export paths used by fingerprint libs ---
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = makeNative(function (
    this: HTMLCanvasElement,
    ...args: [string?, number?]
  ) {
    const copy = buildNoisyCanvasCopy(this);
    return copy
      ? origToDataURL.apply(copy, args)
      : origToDataURL.apply(this, args);
  }, "toDataURL");

  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  if (origToBlob) {
    HTMLCanvasElement.prototype.toBlob = makeNative(function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
      ...args: [string?, number?]
    ) {
      const copy = buildNoisyCanvasCopy(this);
      return copy
        ? origToBlob.call(copy, callback, ...args)
        : origToBlob.call(this, callback, ...args);
    }, "toBlob");
  }

  const canvasProto = HTMLCanvasElement.prototype as HTMLCanvasElement & {
    convertToBlob?: (
      options?: ImageEncodeOptions
    ) => Promise<Blob>;
  };
  const origConvertToBlob = canvasProto.convertToBlob;
  if (origConvertToBlob) {
    canvasProto.convertToBlob = makeNative(function (
      this: HTMLCanvasElement,
      options?: ImageEncodeOptions
    ) {
      const copy = buildNoisyCanvasCopy(this);
      return copy
        ? origConvertToBlob.call(copy, options)
        : origConvertToBlob.call(this, options);
    }, "convertToBlob");
  }

  // --- Intl — align resolved locale/timezone with profile + emulateTimezone ---
  const origResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
  Intl.DateTimeFormat.prototype.resolvedOptions = makeNative(function (
    this: Intl.DateTimeFormat
  ) {
    const resolved = origResolvedOptions.call(this);
    return {
      ...resolved,
      locale: profile.languages[0] ?? resolved.locale,
      timeZone: profile.timezone,
    };
  }, "resolvedOptions");

  // --- AudioFingerprintCollector (OfflineAudioContext pipeline) ---
  const patchOfflineAudioContext = (
    Original: typeof OfflineAudioContext | undefined
  ): void => {
    if (!Original) return;
    const PatchedOfflineAudioContext = makeNative(function (
      this: OfflineAudioContext,
      ...args: ConstructorParameters<typeof OfflineAudioContext>
    ) {
      const ctx = new Original(...args);
      const origStartRendering = ctx.startRendering.bind(ctx);
      ctx.startRendering = makeNative(() => {
        return origStartRendering().then((buffer) => {
          const channel = buffer.getChannelData(0);
          const step = Math.max(100, Math.floor(channel.length / 100));
          const amplitude = ((sessionSeed % 1000) + 1) * 1e-8;
          for (let i = 0; i < channel.length; i += step) {
            channel[i] = (channel[i] ?? 0) + amplitude;
          }
          return buffer;
        });
      }, "startRendering");
      return ctx;
    }, "OfflineAudioContext");
    PatchedOfflineAudioContext.prototype = Original.prototype;
    w.OfflineAudioContext =
      PatchedOfflineAudioContext as unknown as typeof OfflineAudioContext;
    if (w.webkitOfflineAudioContext) {
      w.webkitOfflineAudioContext =
        PatchedOfflineAudioContext as unknown as typeof OfflineAudioContext;
    }
  };
  patchOfflineAudioContext(
    (w.OfflineAudioContext ?? w.webkitOfflineAudioContext) as
      | typeof OfflineAudioContext
      | undefined
  );

  // --- Chrome object — merge into any existing chrome, fill gaps only ---
  const existingChrome = (w.chrome ?? {}) as Record<string, unknown>;
  const existingRuntime = (existingChrome.runtime ?? {}) as Record<string, unknown>;

  const runtimeStub = {
    id: undefined,
    OnInstalledReason: {
      CHROME_UPDATE: "chrome_update",
      INSTALL: "install",
      SHARED_MODULE_UPDATE: "shared_module_update",
      UPDATE: "update",
    },
    OnRestartRequiredReason: {
      APP_UPDATE: "app_update",
      OS_UPDATE: "os_update",
      PERIODIC: "periodic",
    },
    PlatformArch: {
      ARM: "arm",
      ARM64: "arm64",
      MIPS: "mips",
      MIPS64: "mips64",
      X86_32: "x86-32",
      X86_64: "x86-64",
    },
    PlatformOs: {
      ANDROID: "android",
      CROS: "cros",
      LINUX: "linux",
      MAC: "mac",
      OPENBSD: "openbsd",
      WIN: "win",
    },
    PlatformNfcCapability: {
      NFC_CAPABLE: "nfc_capable",
      NFC_NONE: "none",
      NFC_UNSUPPORTED: "unsupported",
    },
    getURL: makeNative((path: string) => `chrome-extension://invalid/${path}`, "getURL"),
    connect: makeNative(() => {
      const port = {
        name: "",
        sender: undefined,
        disconnect: makeNative(() => {}, "disconnect"),
        postMessage: makeNative(() => {}, "postMessage"),
        onDisconnect: {
          addListener: () => {},
          removeListener: () => {},
          hasListener: () => false,
        },
        onMessage: {
          addListener: () => {},
          removeListener: () => {},
          hasListener: () => false,
        },
      };
      return port;
    }, "connect"),
    sendMessage: makeNative(() => {}, "sendMessage"),
    onMessage: {
      addListener: () => {},
      removeListener: () => {},
      hasListener: () => false,
    },
    onConnect: {
      addListener: () => {},
      removeListener: () => {},
      hasListener: () => false,
    },
  };

  w.chrome = {
    ...existingChrome,
    app: {
      isInstalled: false,
      InstallState: {
        DISABLED: "disabled",
        INSTALLED: "installed",
        NOT_INSTALLED: "not_installed",
      },
      RunningState: {
        CANNOT_RUN: "cannot_run",
        READY_TO_RUN: "ready_to_run",
        RUNNING: "running",
      },
      ...(existingChrome.app as object),
    },
    csi:
      existingChrome.csi ??
      makeNative(() => ({ onloadT: Date.now(), startE: Date.now(), pageT: 1 }), "csi"),
    loadTimes:
      existingChrome.loadTimes ??
      makeNative(
        () => ({
          commitLoadTime: Date.now() / 1000,
          connectionInfo: "h2",
          finishDocumentLoadTime: Date.now() / 1000,
          finishLoadTime: Date.now() / 1000,
          firstPaintAfterLoadTime: 0,
          firstPaintTime: Date.now() / 1000,
          navigationType: "Other",
          npnNegotiatedProtocol: "h2",
          requestTime: Date.now() / 1000 - 0.16,
          startLoadTime: Date.now() / 1000 - 0.2,
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
        }),
        "loadTimes"
      ),
    runtime: {
      ...runtimeStub,
      ...existingRuntime,
      onMessage: {
        ...runtimeStub.onMessage,
        ...(existingRuntime.onMessage as object),
      },
      onConnect: {
        ...runtimeStub.onConnect,
        ...(existingRuntime.onConnect as object),
      },
    },
  };

  // --- Permissions ---
  const notificationState: PermissionState =
    Notification.permission === "granted"
      ? "granted"
      : Notification.permission === "denied"
        ? "denied"
        : "prompt";

  const permissionDefaults: Record<string, PermissionState> = {
    notifications: notificationState,
    "clipboard-read": "prompt",
    "clipboard-write": "granted",
    camera: "prompt",
    microphone: "prompt",
    geolocation: "prompt",
    midi: "prompt",
    "background-sync": "granted",
    accelerometer: "granted",
    gyroscope: "granted",
    magnetometer: "granted",
  };

  const origQuery = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = makeNative((parameters: PermissionDescriptor) => {
    const state = permissionDefaults[parameters.name];
    if (state) {
      return Promise.resolve({
        state,
        name: parameters.name,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      } as PermissionStatus);
    }
    return origQuery(parameters);
  }, "query");

  // --- NetworkInformation ---
  defineGetter(navigator, "connection", {
    rtt: profile.connectionRtt,
    downlink: profile.connectionDownlink,
    effectiveType: profile.connectionEffectiveType,
    type: profile.connectionType,
    saveData: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

/**
 * Apply Booking.com anti-bot patches to a Puppeteer page before navigation.
 * Pass an existing profile to keep fingerprint consistent across tabs in one session.
 */
export async function applyBookingAntiDetection(
  page: Page,
  existingProfile?: BookingBrowserProfile
): Promise<BookingBrowserProfile> {
  let profile = existingProfile;

  if (!profile) {
    const [{ platform, source }, geo] = await Promise.all([
      resolveBrowserPlatform(page),
      resolveBrowserGeo(page),
    ]);

    profile = createBookingBrowserProfile(undefined, geo ?? undefined, platform);

    console.info(
      `[anti-detection] Platform=${platform} (${source})` +
        (geo
          ? `, IP=${geo.ip} (${geo.countryCode}), locale=${profile.locale}, tz=${profile.timezone}`
          : ", geo lookup failed — locale defaults only")
    );
  }

  await page.setUserAgent(profile.userAgent);
  await page.setExtraHTTPHeaders(profileHeaders(profile));
  await page.emulateTimezone(profile.timezone);
  await page.setViewport({
    width: profile.viewportWidth,
    height: profile.viewportHeight,
    deviceScaleFactor: profile.devicePixelRatio,
  });

  await clearErrorCatcherCookies(page);
  await page.evaluateOnNewDocument(injectBookingAntiDetection, profile);

  return profile;
}
