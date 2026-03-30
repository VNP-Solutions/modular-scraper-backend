/**
 * Per-job values for Bright Data sticky sessions and browser fingerprinting (Expedia local runs).
 */

const WINDOW_SIZES = [
  { width: 1920, height: 1080 }
];

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

export function getBrightDataSessionId(jobId: string): string {
  const hash = simpleHash(jobId);
  return `job${hash.toString(36).substring(0, 10)}`;
}

export function getBrightDataCountry(_jobId: string): string {
  return "us";
}

export function getTimezone(_jobId: string): string {
  return "America/New_York";
}

export function getAcceptLanguage(_jobId: string): string {
  return "en-US,en;q=0.9";
}

export function getWindowSize(jobId: string): { width: number; height: number } {
  const hash = simpleHash(jobId);
  return WINDOW_SIZES[hash % WINDOW_SIZES.length];
}

/** Fields to attach to Expedia worker jobs for local + Bright Data runs */
export function brightDataFieldsForExpediaJob(jobId: string) {
  return {
    brightDataSessionId: getBrightDataSessionId(jobId),
    windowSize: getWindowSize(jobId),
    timezone: getTimezone(jobId),
    acceptLanguage: getAcceptLanguage(jobId),
  };
}

export interface ExpediaBrightDataOptions {
  brightDataSessionId?: string;
  windowSize?: { width: number; height: number };
  timezone?: string;
  acceptLanguage?: string;
}

/** Merge API/worker overrides with deterministic defaults from jobId */
export function resolveExpediaBrightData(
  jobId: string,
  overrides: ExpediaBrightDataOptions
): ExpediaBrightDataOptions {
  const defaults = brightDataFieldsForExpediaJob(jobId);
  return {
    brightDataSessionId:
      overrides.brightDataSessionId ?? defaults.brightDataSessionId,
    windowSize: overrides.windowSize ?? defaults.windowSize,
    timezone: overrides.timezone ?? defaults.timezone,
    acceptLanguage: overrides.acceptLanguage ?? defaults.acceptLanguage,
  };
}
