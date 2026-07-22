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
  // Booking-specific
  BOOKING_LOGIN_FAILED: "BOOKING_LOGIN_FAILED",
  BOOKING_2FA_FAILED: "BOOKING_2FA_FAILED",
  BOOKING_OTP_FAILED: "BOOKING_OTP_FAILED",
  BOOKING_OTP_CODE_NOT_FOUND: "BOOKING_OTP_CODE_NOT_FOUND",
  BOOKING_SCRAPING_STOPPED: "BOOKING_SCRAPING_STOPPED",
  BOOKING_CAPTCHA_FAILED: "BOOKING_CAPTCHA_FAILED",
  BOOKING_PAGE_LOAD_FAILED: "BOOKING_PAGE_LOAD_FAILED",
  BOOKING_SIGN_IN_TRY_AGAIN_LATER: "BOOKING_SIGN_IN_TRY_AGAIN_LATER",
  BOOKING_TECHNICAL_DIFFICULTIES: "BOOKING_TECHNICAL_DIFFICULTIES",
  BOOKING_CARD_INFO_NOT_AVAILABLE: "BOOKING_CARD_INFO_NOT_AVAILABLE",
} as const;

export type FailedReasonCode = (typeof FAILED_REASON)[keyof typeof FAILED_REASON];

export const BOOKING_SIGN_IN_TRY_AGAIN_LATER_MESSAGE =
  '"Sign in failed, please try again later" show in booking.com';

export const BOOKING_TECHNICAL_DIFFICULTIES_MESSAGE =
  `"We're having technical difficulties – try again later" shows in Booking.com`;

export const BOOKING_CARD_INFO_NOT_AVAILABLE_MESSAGE =
  "Card info not available, try after 7-8 hours later";

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
  // Booking-specific
  [FAILED_REASON.BOOKING_LOGIN_FAILED]:
    "Booking.com login failed. Please check your credentials and try again.",
  [FAILED_REASON.BOOKING_2FA_FAILED]:
    "Booking.com two-factor authentication failed. Please try again.",
  [FAILED_REASON.BOOKING_OTP_FAILED]:
    "Booking.com OTP verification failed. Please check your verification code and try again.",
  [FAILED_REASON.BOOKING_OTP_CODE_NOT_FOUND]:
    "Booking.com OTP verification code not found in email after all attempts. Please check your inbox and try again.",
  [FAILED_REASON.BOOKING_SCRAPING_STOPPED]:
    "Booking.com scraping was stopped manually. Please restart the job.",
  [FAILED_REASON.BOOKING_CAPTCHA_FAILED]:
    "Booking.com CAPTCHA challenge could not be resolved. Please try again.",
  [FAILED_REASON.BOOKING_PAGE_LOAD_FAILED]:
    "Booking.com page failed to load. Please try again.",
  [FAILED_REASON.BOOKING_SIGN_IN_TRY_AGAIN_LATER]:
    BOOKING_SIGN_IN_TRY_AGAIN_LATER_MESSAGE,
  [FAILED_REASON.BOOKING_TECHNICAL_DIFFICULTIES]:
    BOOKING_TECHNICAL_DIFFICULTIES_MESSAGE,
  [FAILED_REASON.BOOKING_CARD_INFO_NOT_AVAILABLE]:
    BOOKING_CARD_INFO_NOT_AVAILABLE_MESSAGE,
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
  return error && typeof error === "object" && error._statusSaved === true;
}

/**
 * Build the error thrown when the very first reservation/card attempt of a
 * job comes back with no card info — Booking.com typically needs 7-8 hours
 * before card details become available, so we fail fast instead of burning
 * through the rest of the reservations.
 */
export function createBookingCardInfoNotAvailableError(): Error {
  const err = new Error(BOOKING_CARD_INFO_NOT_AVAILABLE_MESSAGE);
  setFailedReasonCode(err, FAILED_REASON.BOOKING_CARD_INFO_NOT_AVAILABLE);
  return err;
}

/**
 * Infer the best Booking OTP-related failure code from an error message string.
 */
export function inferBookingOtpFailedReasonCode(
  message?: string
): FailedReasonCode {
  if (!message) return FAILED_REASON.BOOKING_OTP_FAILED;
  const lower = message.toLowerCase();
  if (
    lower.includes("not found") ||
    lower.includes("no code") ||
    lower.includes("failed to get")
  ) {
    return FAILED_REASON.BOOKING_OTP_CODE_NOT_FOUND;
  }
  return FAILED_REASON.BOOKING_OTP_FAILED;
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
