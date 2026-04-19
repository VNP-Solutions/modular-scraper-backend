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

export const UNIVERSAL_LOGIN_IFRAME = 'iframe[data-cy="ul-app-frame"]';

/** Universal Login iframe: verify-otp flow may show Email vs SMS before OTP inputs. */
export const UNIVERSAL_LOGIN_OTP = {
  VERIFY_PANEL: '[data-cy="verify-otp-panel"]',
  OPTION_EMAIL: '[data-cy="otp-option-email"]',
  OPTION_PHONE: '[data-cy="otp-option-phone"]',
  FIRST_INPUT: 'input[data-cy="otp-box-0"]',
} as const;
