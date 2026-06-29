import type { Page } from "puppeteer";

/** Locale fields derived from the browser egress IP (via proxy). */
export interface BrowserGeoInfo {
  ip: string;
  countryCode: string;
  timezone: string;
  acceptLanguage: string;
  languages: string[];
  locale: string;
  lang: string;
  guestCountry: string;
}

interface CountryLocalePreset {
  acceptLanguage: string;
  languages: string[];
  locale: string;
  lang: string;
  guestCountry: string;
  timezone: string;
}

const COUNTRY_PRESETS: Record<string, CountryLocalePreset> = {
  US: {
    acceptLanguage: "en-US,en;q=0.9",
    languages: ["en-US", "en"],
    locale: "en-us",
    lang: "en",
    guestCountry: "us",
    timezone: "America/New_York",
  },
  GB: {
    acceptLanguage: "en-GB,en-US;q=0.9,en;q=0.8",
    languages: ["en-GB", "en-US", "en"],
    locale: "en-gb",
    lang: "en",
    guestCountry: "gb",
    timezone: "Europe/London",
  },
  BD: {
    acceptLanguage: "en-BD,en;q=0.9,bn;q=0.8",
    languages: ["en-BD", "en", "bn"],
    locale: "en-us",
    lang: "en",
    guestCountry: "bd",
    timezone: "Asia/Dhaka",
  },
  IN: {
    acceptLanguage: "en-IN,en;q=0.9,hi;q=0.8",
    languages: ["en-IN", "en", "hi"],
    locale: "en-gb",
    lang: "en",
    guestCountry: "in",
    timezone: "Asia/Kolkata",
  },
  DE: {
    acceptLanguage: "de-DE,de;q=0.9,en;q=0.8",
    languages: ["de-DE", "de", "en"],
    locale: "de",
    lang: "de",
    guestCountry: "de",
    timezone: "Europe/Berlin",
  },
  FR: {
    acceptLanguage: "fr-FR,fr;q=0.9,en;q=0.8",
    languages: ["fr-FR", "fr", "en"],
    locale: "fr",
    lang: "fr",
    guestCountry: "fr",
    timezone: "Europe/Paris",
  },
  NL: {
    acceptLanguage: "nl-NL,nl;q=0.9,en;q=0.8",
    languages: ["nl-NL", "nl", "en"],
    locale: "nl",
    lang: "nl",
    guestCountry: "nl",
    timezone: "Europe/Amsterdam",
  },
  ES: {
    acceptLanguage: "es-ES,es;q=0.9,en;q=0.8",
    languages: ["es-ES", "es", "en"],
    locale: "es",
    lang: "es",
    guestCountry: "es",
    timezone: "Europe/Madrid",
  },
  IT: {
    acceptLanguage: "it-IT,it;q=0.9,en;q=0.8",
    languages: ["it-IT", "it", "en"],
    locale: "it",
    lang: "it",
    guestCountry: "it",
    timezone: "Europe/Rome",
  },
  AU: {
    acceptLanguage: "en-AU,en;q=0.9",
    languages: ["en-AU", "en"],
    locale: "en-au",
    lang: "en",
    guestCountry: "au",
    timezone: "Australia/Sydney",
  },
  CA: {
    acceptLanguage: "en-CA,en;q=0.9,fr;q=0.8",
    languages: ["en-CA", "en", "fr"],
    locale: "en-ca",
    lang: "en",
    guestCountry: "ca",
    timezone: "America/Toronto",
  },
  SG: {
    acceptLanguage: "en-SG,en;q=0.9",
    languages: ["en-SG", "en"],
    locale: "en-gb",
    lang: "en",
    guestCountry: "sg",
    timezone: "Asia/Singapore",
  },
  AE: {
    acceptLanguage: "en-AE,en;q=0.9,ar;q=0.8",
    languages: ["en-AE", "en", "ar"],
    locale: "en-gb",
    lang: "en",
    guestCountry: "ae",
    timezone: "Asia/Dubai",
  },
  PK: {
    acceptLanguage: "en-PK,en;q=0.9,ur;q=0.8",
    languages: ["en-PK", "en", "ur"],
    locale: "en-us",
    lang: "en",
    guestCountry: "pk",
    timezone: "Asia/Karachi",
  },
  PH: {
    acceptLanguage: "en-PH,en;q=0.9,fil;q=0.8",
    languages: ["en-PH", "en", "fil"],
    locale: "en-us",
    lang: "en",
    guestCountry: "ph",
    timezone: "Asia/Manila",
  },
  BR: {
    acceptLanguage: "pt-BR,pt;q=0.9,en;q=0.8",
    languages: ["pt-BR", "pt", "en"],
    locale: "pt-br",
    lang: "pt",
    guestCountry: "br",
    timezone: "America/Sao_Paulo",
  },
  MX: {
    acceptLanguage: "es-MX,es;q=0.9,en;q=0.8",
    languages: ["es-MX", "es", "en"],
    locale: "es-mx",
    lang: "es",
    guestCountry: "mx",
    timezone: "America/Mexico_City",
  },
  JP: {
    acceptLanguage: "ja-JP,ja;q=0.9,en;q=0.8",
    languages: ["ja-JP", "ja", "en"],
    locale: "ja",
    lang: "ja",
    guestCountry: "jp",
    timezone: "Asia/Tokyo",
  },
  KR: {
    acceptLanguage: "ko-KR,ko;q=0.9,en;q=0.8",
    languages: ["ko-KR", "ko", "en"],
    locale: "ko",
    lang: "ko",
    guestCountry: "kr",
    timezone: "Asia/Seoul",
  },
  PL: {
    acceptLanguage: "pl-PL,pl;q=0.9,en;q=0.8",
    languages: ["pl-PL", "pl", "en"],
    locale: "pl",
    lang: "pl",
    guestCountry: "pl",
    timezone: "Europe/Warsaw",
  },
};

const EU_COUNTRY_CODES = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
]);

function normalizeCountryCode(code: string | undefined): string | null {
  if (!code) return null;
  const normalized = code.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function buildGenericPreset(
  countryCode: string,
  timezone?: string
): CountryLocalePreset {
  const cc = countryCode.toUpperCase();
  const guestCountry = cc.toLowerCase();
  const regionTag = `${cc}`;
  const acceptLanguage = `en-${regionTag},en;q=0.9`;
  const languages = [`en-${regionTag}`, "en"];
  const locale = EU_COUNTRY_CODES.has(cc) ? "en-gb" : "en-us";

  return {
    acceptLanguage,
    languages,
    locale,
    lang: "en",
    guestCountry,
    timezone: timezone || "UTC",
  };
}

/** Build locale fields from a country code (and optional API timezone). */
export function buildGeoFromCountryCode(
  countryCode: string,
  ip = "0.0.0.0",
  timezone?: string
): BrowserGeoInfo {
  const cc = normalizeCountryCode(countryCode) ?? "GB";
  const preset = COUNTRY_PRESETS[cc] ?? buildGenericPreset(cc, timezone);
  const resolvedTimezone = timezone || preset.timezone;

  return {
    ip,
    countryCode: cc,
    timezone: resolvedTimezone,
    acceptLanguage: preset.acceptLanguage,
    languages: [...preset.languages],
    locale: preset.locale,
    lang: preset.lang,
    guestCountry: preset.guestCountry,
  };
}

function geoFromEnvFallback(): BrowserGeoInfo | null {
  const raw =
    process.env.BROWSERLESS_PROXY_COUNTRY ||
    process.env.LOCATION_COUNTRY_CODE;
  if (!raw?.trim()) return null;
  return buildGeoFromCountryCode(raw.trim());
}

interface RawGeoPayload {
  source: string;
  data: Record<string, unknown>;
}

function pickString(data: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeGeoPayload(raw: RawGeoPayload): BrowserGeoInfo | null {
  const { data } = raw;
  const ip = pickString(data, ["ip", "query", "ipAddress"]);
  const countryCode = normalizeCountryCode(
    pickString(data, ["country_code", "countryCode", "country"])
  );
  if (!countryCode) return null;

  const timezone =
    pickString(data, ["timezone", "time_zone", "timezone_id"]) ||
    COUNTRY_PRESETS[countryCode]?.timezone;

  const geo = buildGeoFromCountryCode(countryCode, ip ?? "0.0.0.0", timezone);
  return geo;
}

/**
 * Detect egress IP + geo through the browser (respects proxy).
 * Uses in-page fetch so the lookup exits via the same route as Booking traffic.
 */
export async function detectBrowserGeo(page: Page): Promise<BrowserGeoInfo | null> {
  try {
    const currentUrl = page.url();
    if (!currentUrl || currentUrl === "about:blank") {
      await page.goto("about:blank", { waitUntil: "load", timeout: 10000 });
    }

    const raw = await page.evaluate(async (): Promise<RawGeoPayload | null> => {
      const endpoints = [
        "https://ipapi.co/json/",
        "https://ipwho.is/",
        "https://ip-api.com/json/?fields=query,countryCode,timezone,status,message",
      ];

      for (const url of endpoints) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 12000);
          const response = await fetch(url, { signal: controller.signal });
          clearTimeout(timer);
          if (!response.ok) continue;

          const data = (await response.json()) as Record<string, unknown>;
          if (data.status === "fail") continue;
          if (data.success === false) continue;

          return { source: url, data };
        } catch {
          // try next provider
        }
      }
      return null;
    });

    if (raw) {
      const geo = normalizeGeoPayload(raw);
      if (geo) return geo;
    }
  } catch {
    // fall through to env fallback
  }

  return geoFromEnvFallback();
}

export async function resolveBrowserGeo(page: Page): Promise<BrowserGeoInfo | null> {
  const detected = await detectBrowserGeo(page);
  if (detected) return detected;
  return geoFromEnvFallback();
}
