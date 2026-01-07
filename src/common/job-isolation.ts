/**
 * Job Isolation Configuration
 *
 * Provides deterministic isolation configuration for each job:
 * - Unique Bright Data session ID (for unique residential IP per job)
 * - Unique window size (for browser fingerprint diversification)
 * - Consistent US-only settings (timezone, language)
 */

const WINDOW_SIZES = [
  { width: 1920, height: 1080 }, // Full HD
  { width: 1366, height: 768 }, // Common laptop
  { width: 1536, height: 864 }, // MacBook Pro
  { width: 1440, height: 900 }, // MacBook Air
  { width: 1600, height: 900 }, // Wide screen
  { width: 1280, height: 720 }, // HD
];

const AVAILABLE_COUNTRIES = [
  {
    code: "us",
    name: "United States",
    timezones: [
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
      "America/Phoenix",
    ],
    languages: ["en-US", "en"],
  },
];

/**
 * Simple hash function to deterministically assign properties based on jobId
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

/**
 * Get Bright Data country code for a job
 * Always returns "us" for US-only configuration
 */
export function getBrightDataCountry(jobId: string): string {
  return "us"; // Always US
}

/**
 * Get Bright Data country name for a job
 * Always returns "United States" for US-only configuration
 */
export function getBrightDataCountryName(jobId: string): string {
  return "United States"; // Always US
}

/**
 * Get timezone for a job
 * Returns consistent US timezone
 */
export function getTimezone(jobId: string): string {
  // Use a consistent timezone for US
  return "America/New_York";
}

/**
 * Get Accept-Language header for a job
 * Returns consistent US language preference
 */
export function getAcceptLanguage(jobId: string): string {
  // Use a consistent Accept-Language for US
  return "en-US,en;q=0.9";
}

/**
 * Generate a unique Bright Data session ID for a job
 * This ensures each job gets a unique residential IP
 */
export function getBrightDataSessionId(jobId: string): string {
  const hash = simpleHash(jobId);
  return `job${hash.toString(36).substring(0, 10)}`;
}

/**
 * Get window size for a job
 * Returns a deterministic window size based on jobId hash
 */
export function getWindowSize(jobId: string): {
  width: number;
  height: number;
} {
  const hash = simpleHash(jobId);
  return WINDOW_SIZES[hash % WINDOW_SIZES.length];
}
