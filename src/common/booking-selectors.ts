export const BOOKING_SELECTORS = {
  email: [
    'input[name="username"]',
    'input[name="loginname"]',
    '#username',
    'input[type="email"]',
    'input[placeholder*="email"]'
  ],
  password: [
    'input[type="password"]',
    '#password',
    'input[name="password"]',
    'input[name="passwd"]',
    'input[placeholder*="password"]'
  ],
  loginButton: [
    'button[type="submit"]',
    'input[type="submit"]',
  ],
  continueButton: [
    'button[type="submit"]',
    'button:contains("Next")',
    'button:contains("Continue")',
    'input[type="submit"]'
  ],
  tfaSelectors: [
    'input[autocomplete="one-time-code"]',
    'input[type="text"][maxlength="6"]',
    'input[name="pin"]',
    'input[name="code"]',
    'input[placeholder*="code"]'
  ],
  errorMessages: [
    '.error-block',
    '.error-message',
    '.alert-error',
    '.error',
    '.login-error'
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
    vccsToChargeLink: 'a[href*="route=vccs_to_charge"]'
  },
  pagination: {
    nextPageButton: 'a[aria-label="Next page"]',
    previousPageButton: 'a[aria-label="Previous page"]',
    currentPageIndicator: '.pagination__current-page',
    totalPagesIndicator: '.pagination__total-pages',
    pageNumbers: '.pagination__page-number'
  },
  reservations: {
    reservationRow: 'tbody.bui-table__body tr.bui-table__row',
    reservationLink: 'a.bui-link--primary',
    reservationDetailButton: 'a.pay-hub__view_cc_link',
    reservationId: '[data-heading="Reservation info"] a',
    reservationChargeBefore: '[data-heading="Charge before"] span',
    reservationAmount: '[data-heading="Amount"]',
    reservationCardholder: '[data-heading="Cardholder"]'
  }
};

export const CAPTCHA_PATTERNS = [
  /let'?s (make sure|confirm) you'?re? human/i,
  /choose all the clocks/i,
  /you are not a bot/i,
  /confirm.*clocks/i
];

export const TWO_FA_PATTERNS = [
  '2fa',
  'verify',
  'authentication',
  'sign-in/verification',
  'select-phone'
];

export const TWO_FA_TEXT_PATTERNS = [
  'Verification method',
  'nw-signin-verification',
  'verification-pulse-link',
  'sms-verification-link'
];