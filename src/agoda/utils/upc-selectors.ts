/**
 * Selectors for Agoda YCS booking list → Get payout (UPC) automation.
 */

export const UPC_WIDGET = {
  CONTAINER: '[data-testid="ycs-upc-widget"]',
  CARD_HOLDER_NAME: '[data-testid="card-holder-name-value"] p',
  CARD_NUMBER: '[data-testid="card-number-value"] p',
  EXPIRATION_DATE: '[data-testid="card-expiration-date-value"] p',
  CVC_CODE: '[data-testid="card-cvc-code-value"] p',
} as const;

export const BOOKING_LIST_PAGE = {
  /** Booking table container (same as booking-data wait) */
  LIST_BOX: 'div[data-testid="booking-list-box"]',
  SEARCH_INPUT:
    'input[data-element-name="ycs-booking-search-bid-guestname"], input[data-testid="search-box"]',
  SEARCH_BUTTON:
    'button[data-element-name="ycs-booking-search-button"], button[type="submit"]',
} as const;

/** Booking detail sidebar (same as Agoda retrieval / YCS). */
export const BOOKING_DETAIL = {
  TAB_LIST:
    '[data-element-name="ycs-booking-detail-tab"], [data-testid="booking-detail-panel-tabs"]',
  PAYOUT_TAB:
    'button[data-element-name="ycs-booking-detail-tab-payout"], button[data-testid="ycs-booking-detail-tab-payout"]',
  /**
   * Close button inside the detail sidebar header. Escape key does NOT close
   * this panel — we must click this button (or click the search input) to
   * dismiss it before searching for the next reservation.
   */
  CLOSE_BUTTON:
    'button[data-element-name="ycs-booking-detail-close-button"], button[data-testid="panel-toggler-button"]',
} as const;

/** Result row for a specific booking id (retrieval-style stable click target). */
export const BOOKING_RESULT = {
  ROW: (bookingId: string) =>
    `tr[data-testid="booking-result-row-${bookingId}"]`,
  GUEST_NAME: (bookingId: string) =>
    `tr[data-testid="booking-result-row-${bookingId}"] p[data-testid="guest-name"]`,
} as const;

export const UNIVERSAL_LOGIN_IFRAME = 'iframe[data-cy="ul-app-frame"]';

/** Universal Login iframe: verify-otp flow may show Email vs SMS before OTP inputs. */
export const UNIVERSAL_LOGIN_OTP = {
  VERIFY_PANEL: '[data-cy="verify-otp-panel"]',
  OPTION_EMAIL: '[data-cy="otp-option-email"]',
  OPTION_PHONE: '[data-cy="otp-option-phone"]',
  /** Unified auth (current YCS): one input per digit */
  FIRST_INPUT: 'input[data-cy="otp-box-0"]',
  /** Legacy MFA iframe (retrieval branch): data-cy="otp-0" … "otp-5" */
  FIRST_INPUT_LEGACY: '[data-cy="otp-0"]',
  SUBMIT_UNIFIED: 'button[data-cy="unified-auth-otp-continue-button"]',
  SUBMIT_LEGACY: '[data-cy="submit-otp-button"]',
  /** Error banner shown when the submitted OTP is incorrect. */
  FAILED_VERIFY: '[data-cy="failed-verify-otp"]',
} as const;
