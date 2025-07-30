/**
 * Booking-specific error types for enhanced error logging
 * Used with the existing dualLogError system
 */
export enum BookingErrorType {
  TIMEOUT = "timeout",
  BLOCKED = "blocked",
  CAPTCHA = "captcha",
  DOM_NOT_FOUND = "dom_not_found",
  NETWORK_ERROR = "network_error",
  AUTHENTICATION_ERROR = "authentication_error",
  RATE_LIMITED = "rate_limited",
  PRICE_NOT_FOUND = "price_not_found",
  AVAILABILITY_ERROR = "availability_error",
  BOOKING_FORM_ERROR = "booking_form_error",
  LOGIN_FAILED = "login_failed",
  PROPERTY_NOT_FOUND = "property_not_found",
  RERUN_FAILED = "rerun_failed",
  RERUN_INVALID_STATUS = "rerun_invalid_status",
  RERUN_NO_DATA = "rerun_no_data",
  UNKNOWN = "unknown"
}

/**
 * Booking scraping phases for context
 */
export enum BookingScrapingPhase {
  NAVIGATION = "navigation",
  LOGIN = "login",
  PROPERTY_SEARCH = "property_search",
  PRICE_EXTRACTION = "price_extraction",
  AVAILABILITY_CHECK = "availability_check",
  FORM_FILLING = "form_filling"
}

/**
 * Helper function to determine if an error should trigger a retry
 */
export function shouldRetryBookingError(errorType: BookingErrorType): boolean {
  const nonRetryableErrors = [
    BookingErrorType.BLOCKED,
    BookingErrorType.AUTHENTICATION_ERROR,
    BookingErrorType.LOGIN_FAILED,
    BookingErrorType.RATE_LIMITED,
    BookingErrorType.RERUN_INVALID_STATUS,
    BookingErrorType.RERUN_NO_DATA
  ];
  
  return !nonRetryableErrors.includes(errorType);
}

/**
 * Helper function to get error description
 */
export function getBookingErrorDescription(errorType: BookingErrorType): string {
  const descriptions: Record<BookingErrorType, string> = {
    [BookingErrorType.TIMEOUT]: "Operation timed out",
    [BookingErrorType.BLOCKED]: "Access blocked by Booking.com",
    [BookingErrorType.CAPTCHA]: "CAPTCHA challenge detected",
    [BookingErrorType.DOM_NOT_FOUND]: "Required DOM element not found",
    [BookingErrorType.NETWORK_ERROR]: "Network connectivity issue",
    [BookingErrorType.AUTHENTICATION_ERROR]: "Authentication/credential issue",
    [BookingErrorType.RATE_LIMITED]: "Rate limiting detected",
    [BookingErrorType.PRICE_NOT_FOUND]: "Price information not available",
    [BookingErrorType.AVAILABILITY_ERROR]: "Availability data issue",
    [BookingErrorType.BOOKING_FORM_ERROR]: "Form interaction problem",
    [BookingErrorType.LOGIN_FAILED]: "Login process failed",
    [BookingErrorType.PROPERTY_NOT_FOUND]: "Property not found on Booking.com",
    [BookingErrorType.RERUN_FAILED]: "Job rerun execution failed",
    [BookingErrorType.RERUN_INVALID_STATUS]: "Invalid job status for rerun",
    [BookingErrorType.RERUN_NO_DATA]: "No data available for rerun",
    [BookingErrorType.UNKNOWN]: "Unknown error occurred"
  };
  
  return descriptions[errorType];
} 