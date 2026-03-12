/**
 * Central place for job failure reasons. Set a failure code where the error
 * occurs; the UI gets a stable user message from the code instead of parsing
 * error messages.
 */

export const FAILED_REASON = {
  SCRAPING_STOPPED: "SCRAPING_STOPPED",
  OTP_VERIFICATION_FAILED: "OTP_VERIFICATION_FAILED",
  OTP_VERIFICATION_CODE_NOT_FOUND: "OTP_VERIFICATION_CODE_NOT_FOUND",
  OTP_VERIFICATION_PAGE_TIMEOUT: "OTP_VERIFICATION_PAGE_TIMEOUT",
  LOGIN_FAILED: "LOGIN_FAILED",
  PROPERTY_NOT_FOUND: "PROPERTY_NOT_FOUND",
  RETRIEVAL_NOT_FOUND: "RETRIEVAL_NOT_FOUND",
  GRAPHQL_ERROR: "GRAPHQL_ERROR",
  GRAPHQL_NOT_AUTHORIZED: "GRAPHQL_NOT_AUTHORIZED",
  GRAPHQL_TIMEOUT: "GRAPHQL_TIMEOUT",
  REQUEST_TIMEOUT: "REQUEST_TIMEOUT",
  NO_RESERVATIONS_FOUND: "NO_RESERVATIONS_FOUND",
  MAX_RESTART_ATTEMPTS: "MAX_RESTART_ATTEMPTS",
  VCC_NOT_AVAILABLE: "VCC_NOT_AVAILABLE",
  BROWSER_SESSION_LOST: "BROWSER_SESSION_LOST",
} as const;

export type FailedReasonCode = (typeof FAILED_REASON)[keyof typeof FAILED_REASON];

const FAILED_REASON_MESSAGES: Record<FailedReasonCode, string> = {
  [FAILED_REASON.SCRAPING_STOPPED]: "Scraping was stopped",
  [FAILED_REASON.OTP_VERIFICATION_FAILED]:
    "OTP verification failed. Please try again or re-authenticate.",
  [FAILED_REASON.OTP_VERIFICATION_CODE_NOT_FOUND]:
    "Failed to fetch verification code from your email. Re-authenticate to solve this issue.",
  [FAILED_REASON.OTP_VERIFICATION_PAGE_TIMEOUT]:
    "OTP verification timed out. The verification page did not appear in time. Please try again.",
  [FAILED_REASON.LOGIN_FAILED]:
    "Login failed. Please check your Expedia credentials and try again.",
  [FAILED_REASON.PROPERTY_NOT_FOUND]:
    "Property not found. Please verify the Expedia property ID is correct.",
  [FAILED_REASON.RETRIEVAL_NOT_FOUND]:
    "Retrieval not found. The retrieval may have been deleted or the ID is invalid.",
  [FAILED_REASON.GRAPHQL_ERROR]:
    "Failed to fetch reservation data from Expedia. Please try again.",
  [FAILED_REASON.GRAPHQL_NOT_AUTHORIZED]:
    "Expedia's reservation search API returned an authorization error. This is likely temporary — please try again later.",
  [FAILED_REASON.GRAPHQL_TIMEOUT]:
    "Expedia API request timed out. This is likely a temporary network issue. Please try again.",
  [FAILED_REASON.REQUEST_TIMEOUT]:
    "The page did not load in time. Please try again.",
  [FAILED_REASON.NO_RESERVATIONS_FOUND]:
    "No reservations found for the date range",
  [FAILED_REASON.MAX_RESTART_ATTEMPTS]: "Maximum restart attempts exceeded",
  [FAILED_REASON.VCC_NOT_AVAILABLE]: "VCC / virtual card not available",
  [FAILED_REASON.BROWSER_SESSION_LOST]:
    "Browser session was lost. Please try again.",
};

const FAILED_REASON_CODE_KEY = "failedReasonCode" as const;

/**
 * Returns true if the error already has a failure reason code (so callers
 * can avoid overwriting it, e.g. login catch should not overwrite OTP code).
 */
export function hasFailedReasonCode(error: unknown): boolean {
  const code =
    error &&
    typeof error === "object" &&
    (error as Record<string, unknown>)[FAILED_REASON_CODE_KEY];
  return typeof code === "string" && code in FAILED_REASON_MESSAGES;
}

/**
 * Attach a failure reason code to an error so getFailedReasonForUser can
 * resolve a stable user message. Call this at the throw site or in a catch
 * before rethrowing.
 */
export function setFailedReasonCode(
  error: unknown,
  code: FailedReasonCode
): void {
  if (error && typeof error === "object") {
    (error as Record<string, unknown>)[FAILED_REASON_CODE_KEY] = code;
  }
}

/**
 * Infer an OTP-related failure code from an error message. Use in OTP catch
 * when the error was thrown from deep inside OTP flow without a code.
 */
export function inferOtpFailedReasonCode(message: string): FailedReasonCode {
  const msg = String(message || "").toLowerCase();
  if (
    msg.includes("failed to get verification code from email") ||
    msg.includes("no verification code found")
  ) {
    return FAILED_REASON.OTP_VERIFICATION_CODE_NOT_FOUND;
  }
  if (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("exceeded") ||
    msg.includes("navigation")
  ) {
    return FAILED_REASON.OTP_VERIFICATION_PAGE_TIMEOUT;
  }
  return FAILED_REASON.OTP_VERIFICATION_FAILED;
}

/**
 * Mark an error as already having its job status saved to the DB.
 * Outer catches should check this with isStatusAlreadySaved() before
 * calling updateRetrievalStatus again, so the inner catch's reason is not overwritten.
 */
export function markStatusSaved(error: unknown): void {
  if (error && typeof error === "object") {
    (error as Record<string, unknown>)["_statusSaved"] = true;
  }
}

export function isStatusAlreadySaved(error: unknown): boolean {
  return !!(
    error &&
    typeof error === "object" &&
    (error as Record<string, unknown>)["_statusSaved"] === true
  );
}

/**
 * Returns true if the error message is a "Session closed" / "page closed"
 * follow-on (e.g. after OTP failed and browser was closed). Used so we can
 * show a user-friendly message instead of the raw protocol error.
 */
function isSessionClosedFollowOn(message: string): boolean {
  const msg = String(message || "").toLowerCase();
  return (
    msg.includes("session closed") ||
    msg.includes("page has been closed") ||
    msg.includes("network.getcookies")
  );
}

/**
 * Resolve a user-facing failed_reason string from an error. Prefers the
 * explicit failure code set with setFailedReasonCode; otherwise returns
 * the error message or fallback. Result is safe to store (no stack, max length).
 */
export function getFailedReasonForUser(
  error: unknown,
  fallback: string = "Scraping failed"
): string {
  const code =
    error &&
    typeof error === "object" &&
    (error as Record<string, unknown>)[FAILED_REASON_CODE_KEY];
  if (typeof code === "string" && code in FAILED_REASON_MESSAGES) {
    return FAILED_REASON_MESSAGES[code as FailedReasonCode];
  }
  const message = (error as Error)?.message;
  if (typeof message === "string" && isSessionClosedFollowOn(message)) {
    return FAILED_REASON_MESSAGES[FAILED_REASON.OTP_VERIFICATION_PAGE_TIMEOUT];
  }
  const raw =
    typeof message === "string" && message.trim() ? message : fallback;
  return raw.slice(0, 1000);
}

/**
 * Get the user-facing message for a failure code (e.g. when setting status to Failed
 * from a success path with 0 items — no error object available).
 */
export function getFailedReasonMessageForCode(
  code: FailedReasonCode
): string {
  return FAILED_REASON_MESSAGES[code] ?? "Scraping failed";
}
