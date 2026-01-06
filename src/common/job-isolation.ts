/**
 * Job Isolation Helper for Bright Data
 *
 * Provides functions to generate unique isolation configurations for each job:
 * - Unique session ID for Bright Data proxy (ensures different residential IP)
 * - Unique window size
 * - Country selection (US only)
 *
 * Uses hash-based assignment to ensure deterministic but unique values per jobId
 */

const WINDOW_SIZES = [
  { width: 1920, height: 1080 }, // Full HD
  { width: 1366, height: 768 }, // Common laptop
  { width: 1536, height: 864 }, // MacBook Pro
  { width: 1440, height: 900 }, // MacBook Air
  { width: 1600, height: 900 }, // Wide screen
  { width: 1280, height: 720 }, // HD
];

// Available countries in your Bright Data zone (US only)
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
 * Simple hash function to convert string to number
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
 * Get country code for a job based on jobId hash
 * Returns US (only available country)
 *
 * @param jobId - The job ID to generate country for
 * @returns Country code ("us")
 */
export function getBrightDataCountry(jobId: string): string {
  return "us"; // Always US
}

/**
 * Get country name for a job
 *
 * @param jobId - The job ID to get country name for
 * @returns Country name ("United States")
 */
export function getBrightDataCountryName(jobId: string): string {
  return "United States"; // Always US
}

/**
 * Get timezone for a job based on country (US timezones only)
 * Uses consistent timezone per job (not randomized) for realistic fingerprint
 *
 * @param jobId - The job ID to get timezone for
 * @returns Timezone string (e.g., "America/New_York")
 */
export function getTimezone(jobId: string): string {
  // Use consistent timezone - most common US timezone (Eastern Time)
  // This creates realistic, consistent fingerprints instead of random ones
  return "America/New_York";
}

/**
 * Get Accept-Language header for a job based on country (US only)
 * Uses realistic, consistent language header
 *
 * @param jobId - The job ID to get language for
 * @returns Accept-Language string (e.g., "en-US,en;q=0.9")
 */
export function getAcceptLanguage(jobId: string): string {
  // Use realistic, consistent US language header
  return "en-US,en;q=0.9";
}

/**
 * Generate unique session ID for Bright Data proxy
 * Bright Data uses session ID in username format: username-session-{sessionId}
 * Different session IDs = different residential IPs
 *
 * @param jobId - The job ID to generate session ID for
 * @returns A session ID string (e.g., "job123abc")
 */
export function getBrightDataSessionId(jobId: string): string {
  // Use jobId hash to create a unique session ID
  // This ensures same jobId always gets same session (deterministic)
  const hash = simpleHash(jobId);
  // Create a readable session ID from hash
  return `job${hash.toString(36).substring(0, 10)}`;
}

/**
 * Get window size for a job based on jobId hash
 * @param jobId - The job ID to generate window size for
 * @returns An object with width and height properties
 */
export function getWindowSize(jobId: string): {
  width: number;
  height: number;
} {
  const hash = simpleHash(jobId);
  return WINDOW_SIZES[hash % WINDOW_SIZES.length];
}
