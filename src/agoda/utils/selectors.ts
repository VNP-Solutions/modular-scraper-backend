/**
 * Centralized Selectors for Agoda Retrieval Data Scraping
 *
 * This file contains all CSS selectors used in the Agoda retrieval scraping process.
 * Centralizing selectors makes it easier to maintain and update when the UI changes.
 */

/**
 * Booking Search Selectors
 */
export const BOOKING_SEARCH = {
  // Input field for booking ID / guest name
  INPUT:
    'input[data-element-name="ycs-booking-search-bid-guestname"], input[data-testid="search-box"]',

  // Search button
  BUTTON:
    'button[data-element-name="ycs-booking-search-button-apply"], button[data-testid="search-btn"]',
} as const;

/**
 * Booking Results Selectors
 */
export const BOOKING_RESULTS = {
  // Booking result row (requires bookingId interpolation)
  ROW: (bookingId: string) =>
    `tr[data-testid="booking-result-row-${bookingId}"]`,

  // Guest name within booking row (requires bookingId interpolation)
  GUEST_NAME: (bookingId: string) =>
    `tr[data-testid="booking-result-row-${bookingId}"] p[data-testid="guest-name"]`,

  // Guest name selector (standalone)
  GUEST_NAME_STANDALONE: 'p[data-testid="guest-name"]',
} as const;

/**
 * Booking Detail Sidebar Selectors
 */
export const BOOKING_DETAIL = {
  // Tab list container
  TAB_LIST:
    '[data-element-name="ycs-booking-detail-tab"], [data-testid="booking-detail-panel-tabs"]',

  // Get payout (UPC) tab button
  PAYOUT_TAB:
    'button[data-element-name="ycs-booking-detail-tab-payout"], button[data-testid="ycs-booking-detail-tab-payout"]',
} as const;

/**
 * OTP Verification Selectors
 */
export const OTP_VERIFICATION = {
  // OTP verification method selection - Email option
  EMAIL_OPTION: '[data-cy="otp-option-email"]',

  // OTP input fields (requires index 0-5)
  INPUT: (index: number) => `[data-cy="otp-${index}"]`,

  // First OTP input field (for waiting)
  FIRST_INPUT: '[data-cy="otp-0"]',

  // Submit OTP button
  SUBMIT_BUTTON: '[data-cy="submit-otp-button"]',
} as const;

/**
 * UPC Widget Selectors
 */
export const UPC_WIDGET = {
  // Main UPC widget container
  CONTAINER: '[data-testid="ycs-upc-widget"]',

  // Card holder name value
  CARD_HOLDER_NAME: '[data-testid="card-holder-name-value"] p',

  // Card number value
  CARD_NUMBER: '[data-testid="card-number-value"] p',

  // Card expiration date value
  EXPIRATION_DATE: '[data-testid="card-expiration-date-value"] p',

  // CVC code value
  CVC_CODE: '[data-testid="card-cvc-code-value"] p',
} as const;

/**
 * Helper function to check if OTP form exists
 * Used in evaluate() functions
 */
export const OTP_CHECK_SELECTORS = {
  EMAIL_OPTION: '[data-cy="otp-option-email"]',
  FIRST_INPUT: '[data-cy="otp-0"]',
} as const;

/**
 * Page Navigation and Loading Selectors
 */
export const PAGE_LOADING = {
  // Body element (for waiting for page load)
  BODY: "body",

  // H2 heading element selector
  H2_HEADING: "h2",
} as const;

/**
 * Reservations Page Selectors
 * Used to verify that the booking page has loaded correctly
 */
export const RESERVATIONS_PAGE = {
  // Multiple selectors to find the "Reservations" heading/text
  // These are tried in order until one matches
  SELECTORS: [
    'h2:has-text("Reservations")',
    "h2.sc-iMTnTL.sc-krNlru.ioCOri.jnyliE",
    'h2:contains("Reservations")',
    '[class*="Reservations"]',
  ] as const,

  // Text to search for in page content
  TEXT: "Reservations",
} as const;

/**
 * Progress Status Constants
 * Used for tracking job progress in the Agoda retrieval process
 */
export const PROGRESS_STATUS = {
  // Initialization phase
  AUTOMATION_INITIALIZED: "agoda_automation_initialized",

  // Browser setup phase
  BROWSER_SETUP_COMPLETE: "agoda_browser_setup_complete",

  // Login phase
  LOGIN_COMPLETE: "agoda_login_complete",

  // Booking data retrieval phase
  BOOKING_DATA_RETRIEVAL: "agoda_booking_data_retrieval",
} as const;

/**
 * Screenshot Name Constants
 * Used for naming screenshots taken during the Agoda retrieval process
 */
export const SCREENSHOT_NAMES = {
  // Browser setup screenshots
  BROWSER_SETUP_COMPLETED: "browser_setup_completed",

  // Login screenshots
  LOGIN_COMPLETED: "login_completed",

  // Booking data screenshots
  BOOKING_DATA_COMPLETED: "booking_data_completed",
  BOOKING_PAGE_LOADED: "booking_page_loaded",

  // Job completion screenshots
  JOB_COMPLETED_SUCCESSFULLY: "job_completed_successfully",

  // Error screenshots
  AGODA_AUTOMATION_ERROR: "agoda_automation_error",
} as const;

/**
 * Environment and Configuration Constants
 */
export const CONFIG = {
  // Environment values
  ENVIRONMENT: {
    PRODUCTION: "production",
    LOCAL: "local",
    DEFAULT: "production",
  } as const,

  // OTA provider names
  OTA_PROVIDER: {
    AGODA: "agoda",
  } as const,

  // Error stage identifiers
  ERROR_STAGE: {
    OUTER_MAIN_FUNCTION: "outer_main_function",
  } as const,
} as const;
