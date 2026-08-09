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
  BOOKING_TOO_MANY_ATTEMPTS: "BOOKING_TOO_MANY_ATTEMPTS",
} as const;

export type FailedReasonCode = (typeof FAILED_REASON)[keyof typeof FAILED_REASON];

export const BOOKING_SIGN_IN_TRY_AGAIN_LATER_MESSAGE =
  '"Sign in failed, please try again later" show in booking.com';

export const BOOKING_TECHNICAL_DIFFICULTIES_MESSAGE =
  `"We're having technical difficulties – try again later" shows in Booking.com`;

export const BOOKING_CARD_INFO_NOT_AVAILABLE_MESSAGE =
  "Card info not available, try after 7-8 hours later";

export const BOOKING_TOO_MANY_ATTEMPTS_MESSAGE =
  '"Too many attempts – try again later" shows in booking.com';

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
  [FAILED_REASON.BOOKING_TOO_MANY_ATTEMPTS]: BOOKING_TOO_MANY_ATTEMPTS_MESSAGE,
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
 * Booking.com shows "Too many attempts – try again later" on the phone-selection
 * page (before OTP input). The scraper pauses and retries the current property
 * scrape; this marker distinguishes that case from the same banner elsewhere.
 */
export function createBookingPhoneSelectionTooManyAttemptsError(
  visibleText?: string
): Error {
  const err = new Error(BOOKING_TOO_MANY_ATTEMPTS_MESSAGE);
  setFailedReasonCode(err, FAILED_REASON.BOOKING_TOO_MANY_ATTEMPTS);
  (err as Error & { _bookingPhoneSelectionRateLimit?: boolean })._bookingPhoneSelectionRateLimit =
    true;
  if (visibleText) {
    (err as Error & { _bookingRateLimitVisibleText?: string })._bookingRateLimitVisibleText =
      visibleText;
  }
  return err;
}

export function isBookingPhoneSelectionTooManyAttemptsError(error: any): boolean {
  return (
    hasFailedReasonCode(error) &&
    error.failedReasonCode === FAILED_REASON.BOOKING_TOO_MANY_ATTEMPTS &&
    error._bookingPhoneSelectionRateLimit === true
  );
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
 * Failure reasons that indicate an account/session-wide block (e.g. a
 * server-side rate limit) rather than a problem specific to the current
 * property. When one of these occurs mid-group, retrying the remaining
 * queued properties in the same run would almost certainly hit the same
 * wall, so the whole remaining group should be failed immediately instead
 * of attempted one-by-one.
 */
const FATAL_GROUP_ABORT_REASONS: ReadonlySet<FailedReasonCode> = new Set([
  FAILED_REASON.BOOKING_TOO_MANY_ATTEMPTS,
  // Booking.com not having card details ready is a backend-wide delay
  // (typically 7-8 hours), not specific to one property — every other
  // queued property in the same account/session would almost certainly
  // hit the same "no card info yet" wall too.
  FAILED_REASON.BOOKING_CARD_INFO_NOT_AVAILABLE,
  // Both are Booking.com server-side sign-in errors (not credential issues)
  // that can also surface from a mid-group re-login (e.g. session dropped
  // between properties) — every other queued property re-logging in on
  // the same account would almost certainly hit the same server error too.
  FAILED_REASON.BOOKING_SIGN_IN_TRY_AGAIN_LATER,
  FAILED_REASON.BOOKING_TECHNICAL_DIFFICULTIES,
  // The automated OTP handler already exhausts its own retries/timeouts
  // before throwing these — a code that never arrived by SMS/email or an
  // OTP flow that never resolved is almost always an account/session-wide
  // issue (e.g. delivery outage, rate limiting), not specific to one
  // property, so don't burn time attempting the rest of the group.
  FAILED_REASON.BOOKING_OTP_CODE_NOT_FOUND,
  FAILED_REASON.BOOKING_OTP_FAILED,
]);

/**
 * Returns true if the error carries a failedReasonCode that should abort the
 * rest of a Booking.com group run (see {@link FATAL_GROUP_ABORT_REASONS}).
 */
export function isFatalBookingGroupAbortError(error: any): boolean {
  return (
    hasFailedReasonCode(error) &&
    FATAL_GROUP_ABORT_REASONS.has(error.failedReasonCode as FailedReasonCode)
  );
}

/**
 * Subset of the fatal group-abort reasons where Booking.com never even
 * shows an OTP input to begin with (rate-limit banner, server error page,
 * "check back in 7-8 hours" message) — there is no field for a human to
 * manually solve no matter the environment, so the Browserless "wait for
 * manual 2FA" fallback should never be attempted for these. This is
 * intentionally a *subset* of {@link FATAL_GROUP_ABORT_REASONS}: OTP
 * failures (wrong/missing code) do have a real OTP input, so those are
 * excluded here and instead get the manual-solve fallback in
 * Browserless/production mode.
 */
const NO_MANUAL_2FA_SOLVE_REASONS: ReadonlySet<FailedReasonCode> = new Set([
  FAILED_REASON.BOOKING_TOO_MANY_ATTEMPTS,
  FAILED_REASON.BOOKING_CARD_INFO_NOT_AVAILABLE,
  FAILED_REASON.BOOKING_SIGN_IN_TRY_AGAIN_LATER,
  FAILED_REASON.BOOKING_TECHNICAL_DIFFICULTIES,
]);

/**
 * Returns true if the error's failedReasonCode is one where Booking.com
 * never shows an OTP field to solve, so a human on a Browserless live URL
 * has nothing to act on — the job should fail immediately regardless of
 * environment (see {@link NO_MANUAL_2FA_SOLVE_REASONS}).
 */
export function hasNoManual2FASolvePossible(error: any): boolean {
  return (
    hasFailedReasonCode(error) &&
    NO_MANUAL_2FA_SOLVE_REASONS.has(error.failedReasonCode as FailedReasonCode)
  );
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
