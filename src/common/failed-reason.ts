export const FAILED_REASON = {
  SCRAPING_STOPPED: "SCRAPING_STOPPED",
  OTP_VERIFICATION_FAILED: "OTP_VERIFICATION_FAILED",
  OTP_VERIFICATION_CODE_NOT_FOUND: "OTP_VERIFICATION_CODE_NOT_FOUND",
  OTP_VERIFICATION_PAGE_TIMEOUT: "OTP_VERIFICATION_PAGE_TIMEOUT",
  LOGIN_FAILED: "LOGIN_FAILED",
  PROPERTY_NOT_FOUND: "PROPERTY_NOT_FOUND",
  REQUEST_TIMEOUT: "REQUEST_TIMEOUT",
  NO_RESERVATIONS_FOUND: "NO_RESERVATIONS_FOUND",
  MAX_RESTART_ATTEMPTS: "MAX_RESTART_ATTEMPTS",
  BROWSER_SESSION_LOST: "BROWSER_SESSION_LOST",
  // Agoda-specific
  AGODA_LOGIN_FAILED: "AGODA_LOGIN_FAILED",
  AGODA_OTP_FAILED: "AGODA_OTP_FAILED",
  AGODA_OTP_CODE_NOT_FOUND: "AGODA_OTP_CODE_NOT_FOUND",
  AGODA_EMAIL_LINK_NOT_FOUND: "AGODA_EMAIL_LINK_NOT_FOUND",
  AGODA_PAGE_LOAD_FAILED: "AGODA_PAGE_LOAD_FAILED",
  AGODA_SCRAPING_STOPPED: "AGODA_SCRAPING_STOPPED",
} as const;

export type FailedReasonCode = (typeof FAILED_REASON)[keyof typeof FAILED_REASON];

const FAILED_REASON_MESSAGES: Record<FailedReasonCode, string> = {
  [FAILED_REASON.SCRAPING_STOPPED]:
    "Scraping was stopped manually. Please restart the job.",
  [FAILED_REASON.OTP_VERIFICATION_FAILED]:
    "OTP verification failed. Please check your OTP and try again.",
  [FAILED_REASON.OTP_VERIFICATION_CODE_NOT_FOUND]:
    "OTP code not found in email. Please check your inbox and try again.",
  [FAILED_REASON.OTP_VERIFICATION_PAGE_TIMEOUT]:
    "OTP verification timed out. The verification page did not appear in time. Please try again.",
  [FAILED_REASON.LOGIN_FAILED]:
    "Login failed. Please check your credentials and try again.",
  [FAILED_REASON.PROPERTY_NOT_FOUND]:
    "Property not found. Please verify the property ID.",
  [FAILED_REASON.REQUEST_TIMEOUT]:
    "Request timed out or page did not load in time. Please try again.",
  [FAILED_REASON.NO_RESERVATIONS_FOUND]:
    "No reservations found for the specified date range.",
  [FAILED_REASON.MAX_RESTART_ATTEMPTS]:
    "Maximum restart attempts reached. Please contact support.",
  [FAILED_REASON.BROWSER_SESSION_LOST]:
    "Browser session was lost. Please try again.",
  // Agoda-specific
  [FAILED_REASON.AGODA_LOGIN_FAILED]:
    "Agoda login failed. Please check your credentials and try again.",
  [FAILED_REASON.AGODA_OTP_FAILED]:
    "Agoda OTP verification failed. Please check your OTP and try again.",
  [FAILED_REASON.AGODA_OTP_CODE_NOT_FOUND]:
    "Agoda OTP code not found in email after all attempts. Please check your inbox and try again.",
  [FAILED_REASON.AGODA_EMAIL_LINK_NOT_FOUND]:
    "Agoda sign-in email link not found after all attempts. Please check your inbox and try again.",
  [FAILED_REASON.AGODA_PAGE_LOAD_FAILED]:
    "Agoda page failed to load. Please try again.",
  [FAILED_REASON.AGODA_SCRAPING_STOPPED]:
    "Agoda scraping was stopped manually. Please restart the job.",
};

/**
 * Attach a failedReasonCode to an error object so inner catch blocks can
 * communicate the exact reason to outer catch blocks without overwriting it.
 */
export function setFailedReasonCode(error: any, code: FailedReasonCode): void {
  if (error && typeof error === "object") {
    error.failedReasonCode = code;
  }
}

/**
 * Returns true if the error already has a failedReasonCode stamped on it.
 */
export function hasFailedReasonCode(error: any): boolean {
  return (
    error &&
    typeof error === "object" &&
    typeof error.failedReasonCode === "string"
  );
}

/**
 * Mark that a DB status update has already been saved for this error,
 * so outer catch blocks skip their own update (first-writer-wins pattern).
 */
export function markStatusSaved(error: any): void {
  if (error && typeof error === "object") {
    error._statusSaved = true;
  }
}

/**
 * Returns true if an inner catch block already wrote the status/failed_reason
 * to the DB for this error.
 */
export function isStatusAlreadySaved(error: any): boolean {
  return (
    error && typeof error === "object" && error._statusSaved === true
  );
}

/**
 * Infer the best OTP-related failure code from an error message string.
 */
export function inferAgodaOtpFailedReasonCode(
  message?: string
): FailedReasonCode {
  if (!message) return FAILED_REASON.AGODA_OTP_FAILED;
  const lower = message.toLowerCase();
  if (lower.includes("not found") || lower.includes("no otp")) {
    return FAILED_REASON.AGODA_OTP_CODE_NOT_FOUND;
  }
  if (lower.includes("sign-in link") || lower.includes("signin link")) {
    return FAILED_REASON.AGODA_EMAIL_LINK_NOT_FOUND;
  }
  return FAILED_REASON.AGODA_OTP_FAILED;
}

/**
 * Get a user-friendly failure reason string from an error.
 * Uses failedReasonCode if present, otherwise returns a generic message.
 */
export function getFailedReasonForUser(error: any): string | undefined {
  if (!error) return undefined;
  const code = error.failedReasonCode as FailedReasonCode | undefined;
  if (code && FAILED_REASON_MESSAGES[code]) {
    return FAILED_REASON_MESSAGES[code];
  }
  return undefined;
}
