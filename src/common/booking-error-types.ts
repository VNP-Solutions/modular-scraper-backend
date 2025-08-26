export enum PlatformsType {
  BOOKING = 'booking'
}
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
  RESERVATION_NOT_FOUND = "reservation_not_found",
  RERUN_FAILED = "rerun_failed",
  RERUN_INVALID_STATUS = "rerun_invalid_status",
  RERUN_NO_DATA = "rerun_no_data",
  UNKNOWN = "unknown",
  TWO_FA_ERROR = "two_fa_error",
  SCRAPING_STOPPED = "scraping_stopped",
  SCRAPING_PAUSED = "scraping_paused"
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
  FORM_FILLING = "form_filling",
  BUILDING_TRUST = "BUILDING_TRUST"
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
    [BookingErrorType.TIMEOUT]: `[${PlatformsType.BOOKING}] Operation timed out`,
    [BookingErrorType.BLOCKED]: `[${PlatformsType.BOOKING}] Access blocked by Booking.com`,
    [BookingErrorType.CAPTCHA]: `[${PlatformsType.BOOKING}] CAPTCHA challenge detected`,
    [BookingErrorType.DOM_NOT_FOUND]: `[${PlatformsType.BOOKING}] Required DOM element not found`,
    [BookingErrorType.NETWORK_ERROR]: `[${PlatformsType.BOOKING}] Network connectivity issue`,
    [BookingErrorType.AUTHENTICATION_ERROR]: `[${PlatformsType.BOOKING}] Authentication/credential issue`,
    [BookingErrorType.RATE_LIMITED]: `[${PlatformsType.BOOKING}] Rate limiting detected`,
    [BookingErrorType.PRICE_NOT_FOUND]: `[${PlatformsType.BOOKING}] Price information not available`,
    [BookingErrorType.AVAILABILITY_ERROR]: `[${PlatformsType.BOOKING}] Availability data issue`,
    [BookingErrorType.BOOKING_FORM_ERROR]: `[${PlatformsType.BOOKING}] Form interaction problem`,
    [BookingErrorType.LOGIN_FAILED]: `[${PlatformsType.BOOKING}] Login process failed`,
    [BookingErrorType.PROPERTY_NOT_FOUND]: `[${PlatformsType.BOOKING}] Property search failed`,
    [BookingErrorType.RESERVATION_NOT_FOUND]: `[${PlatformsType.BOOKING}] Reservation page loading failed`,
    [BookingErrorType.RERUN_FAILED]: `[${PlatformsType.BOOKING}] Job rerun execution failed`,
    [BookingErrorType.RERUN_INVALID_STATUS]: `[${PlatformsType.BOOKING}] Invalid job status for rerun`,
    [BookingErrorType.RERUN_NO_DATA]: `[${PlatformsType.BOOKING}] No data available for rerun`,
    [BookingErrorType.UNKNOWN]: `[${PlatformsType.BOOKING}] Unknown error occurred`,
    [BookingErrorType.TWO_FA_ERROR]: `[${PlatformsType.BOOKING}] 2FA handling failed`,
    [BookingErrorType.SCRAPING_STOPPED]: `[${PlatformsType.BOOKING}] Scraping was stopped by user request`,
    [BookingErrorType.SCRAPING_PAUSED]: `[${PlatformsType.BOOKING}] Scraping was paused by user request`,
  };
  
  return descriptions[errorType];
} 