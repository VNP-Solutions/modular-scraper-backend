export const BOOKING_SELECTORS = {
  email: [
    'input[name="username"]',
    'input[name="loginname"]',
    "#username",
    'input[type="email"]',
    'input[placeholder*="email"]',
  ],
  password: [
    'input[type="password"]',
    "#password",
    'input[name="password"]',
    'input[name="passwd"]',
    'input[placeholder*="password"]',
  ],
  loginButton: ['button[type="submit"]', 'input[type="submit"]'],
  continueButton: [
    'button[type="submit"]',
    'button:contains("Next")',
    'button:contains("Continue")',
    'input[type="submit"]',
  ],
  tfaSelectors: [
    'input[autocomplete="one-time-code"]',
    'input[type="text"][maxlength="6"]',
    'input[name="pin"]',
    'input[name="code"]',
    'input[placeholder*="code"]',
  ],
  errorMessages: [
    ".error-block",
    ".error-message",
    ".alert-error",
    ".error",
    ".login-error",
  ],
  navigation: {
    mainMenu: (mainSection: string) => [
      `li[data-nav-tag="${mainSection}"] button[data-tid="item-link"]`,
      `li[data-nav-tag="${mainSection}"] .ext-navigation-top-item__link`,
    ],
    subMenu: (subSection: string) => [
      `li[data-nav-tag="${subSection}"] a[data-tid="item-link"]`,
      `a.ext-navigation-submenu-item__link[href*="${subSection}"]`,
      `a[data-tid="item-link"][href*="${subSection}"]`,
    ],
  },
  vccs: {
    vccsToChargeLink: 'a[href*="route=vccs_to_charge"]',
    table: ".pay-hub__table",
    viewCardDetailsLink: "a.pay-hub__view_cc_link",
  },
  pagination: {
    nextPageButton: 'a[aria-label="Next page"]',
    previousPageButton: 'a[aria-label="Previous page"]',
    currentPageIndicator: ".pagination__current-page",
    totalPagesIndicator: ".pagination__total-pages",
    pageNumbers: ".pagination__page-number",
  },
  reservations: {
    reservationRow: "tbody.bui-table__body tr.bui-table__row",
    reservationLink: "a.bui-link--primary",
    reservationDetailButton: "a.pay-hub__view_cc_link",
    reservationId: '[data-heading="Reservation info"] a',
    reservationChargeBefore: '[data-heading="Charge before"] span',
    reservationAmount: '[data-heading="Amount"]',
    reservationCardholder: '[data-heading="Cardholder"]',
    reservationName: 'span[data-test-id="reservation-overview-name"]',
    closeCardDetails: ["#close_button", 'button[data-testid="close"]', 'button.close', 'button[aria-label="Close"]'],
    item: (reservationId: string) => [
      `a[href*="res_id=${reservationId}"]`,
      `a[href*="res_id=${reservationId}"][target="_blank"]`,
      `a.bui-link--primary[href*="res_id=${reservationId}"]`,
      `a[href*="res_id=${reservationId}"]`,
    ],
  },
  property: {
    searchInput: [
      'input[name="hotel_id"]',
      'input[placeholder*="property"]',
      'input[placeholder*="hotel"]',
      ".property-search input",
      ".hotel-search input",
      'input[type="text"]',
      'input[data-test-id="property-search"]',
      'input[data-test-id="hotel-search"]',
    ],
    item: (propertyId: string) => [
      `a[href*="hotel_id=${propertyId}"][target="_blank"]`,
      `a[href*="hotel_id=${propertyId}&"]`,
      `a[href*="hotel_id=${propertyId}"]`,
      `a[href*="hotel_id=${propertyId}"]:contains("${propertyId}")`,
      `a[href*="hotel_id=${propertyId}"]`,
      `a[href*="${propertyId}"]`,
      `a:contains("${propertyId}")`,
    ],
  },
};

export const CAPTCHA_PATTERNS = [
  /let'?s (make sure|confirm) you'?re? human/i,
  /choose all the clocks/i,
  /you are not a bot/i,
  /confirm.*clocks/i,
];

export const TWO_FA_PATTERNS = [
  "2fa",
  "verify",
  "authentication",
  "sign-in/verification",
  "select-phone",
];

export const TWO_FA_TEXT_PATTERNS = [
  "Verification method",
  "Verify your identity",
  "nw-signin-verification",
  "verification-pulse-link",
  "sms-verification-link",
  "Text message (SMS)",
];

export const BOOKING_LOGIN_SUCCESS_URLS = [
  "admin.booking.com",
  "account.business.booking.com",
  "partner",
];

export const BOOKING_LOGIN_EXCLUDE_URLS = ["sign-in"];

export const ACCOUNT_LOCKED_PATTERNS = [
  /account locked/i,
  /we'?ve locked your.*account/i,
  /locked your.*booking\.com account/i,
  /nw-account-locked/i,
  /unlock with email/i,
];

export const ACCOUNT_LOCKED_SELECTORS = {
  unlockButton: [
    '.nw-account-locked button[type="submit"]',
    'form.nw-account-locked button[type="submit"]',
    'button[type="submit"].Y2GrMepHg4YXB1IIqu9a',
    'button.Y2GrMepHg4YXB1IIqu9a[type="submit"]',
  ],
  checkInboxHeader: [
    "h1.slu34oiFrdKys6tKacjT.nw-step-header",
    ".nw-step-header",
    ".nw-account-recovery-confirmation h1",
  ],
  obscuredEmailHint: [
    ".nw-account-recovery-confirmation strong",
    ".bui-spacer--largest strong",
    ".page-header strong",
  ],
  passwordResetForm: [
    ".nw-reset-password",
    "form.nw-reset-password",
    "h1.slu34oiFrdKys6tKacjT.nw-step-header",
  ],
  newPasswordInput: [
    'input[name="new_password"]',
    "#new_password",
    'input[type="password"][name="new_password"]',
    '.nw-password input[type="password"]',
  ],
  confirmPasswordInput: [
    'input[name="confirmed_password"]',
    "#confirmed_password",
    'input[type="password"][name="confirmed_password"]',
    '.nw-confirm-password input[type="password"]',
  ],
  setPasswordButton: [
    '.nw-reset-password button[type="submit"]',
    'form.nw-reset-password button[type="submit"]',
    'button[type="submit"].Y2GrMepHg4YXB1IIqu9a',
  ],
};

export const PASSWORD_MISMATCH_PATTERNS = [
  /username and password.*don't match/i,
  /password.*incorrect/i,
  /invalid.*credentials/i,
  /after \d+ attempts.*account will be locked/i,
];

/** Transient Booking.com server error — not a password mismatch; do not trigger forgot-password flow. */
export const BOOKING_TECHNICAL_DIFFICULTIES_PATTERN =
  /we'?re having technical difficulties.*try again later/i;

/** Booking.com sign-in server error — fail the job immediately; do not trigger forgot-password flow. */
export const BOOKING_SIGN_IN_TRY_AGAIN_LATER_PATTERN =
  /sign[- ]?in failed.*please try again later/i;

/** DOM selectors for the visible sign-in password error (not bundled JS/i18n strings). */
export const BOOKING_SIGN_IN_ERROR_SELECTORS = [
  "#password-note .error-block",
  "#password-note",
  ".nw-password .error-block",
] as const;

export function matchesBookingPasswordMismatch(text: string): boolean {
  return PASSWORD_MISMATCH_PATTERNS.some((pattern) => pattern.test(text));
}

export function matchesBookingTechnicalDifficulties(text: string): boolean {
  return BOOKING_TECHNICAL_DIFFICULTIES_PATTERN.test(text);
}

export function matchesBookingSignInTryAgainLater(text: string): boolean {
  return BOOKING_SIGN_IN_TRY_AGAIN_LATER_PATTERN.test(text);
}

export const PASSWORD_RECOVERY_SELECTORS = {
  forgotPasswordButton: [
    "button.nw-link-account-recovery",
    'button[data-ga-label="forgot password"]',
    ".nw-link-account-recovery",
  ],
  usernameRecoveryForm: ["form.nw-account-recovery", ".nw-account-recovery"],
  usernameInput: [
    'input[name="login_name_recovery"]',
    "#login_name_recovery",
    '.nw-login-name input[type="text"]',
  ],
  sendResetLinkButton: [
    'form.nw-account-recovery button[type="submit"]',
    '.nw-account-recovery button[type="submit"]',
    'button[type="submit"].Y2GrMepHg4YXB1IIqu9a',
  ],
};
