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
    vccsToChargeLink: 'a[href*="route=vccs_to_charge"]',
    table: 'pay-hub__table',
    viewCardDetailsLink: 'a.pay-hub__view_cc_link',
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
    reservationCardholder: '[data-heading="Cardholder"]',
    reservationName: 'span[data-test-id="reservation-overview-name"]',
    closeCardDetails: ['#close_button', '//button[text()="Close"]'],
    item: (reservationId: string) => [
      `a[href*="res_id=${reservationId}"]`,
      `a[href*="res_id=${reservationId}"]:contains("${reservationId}")`
    ],
  },
  property: {
    searchInput: [
      'input[name="hotel_id"]',
      'input[placeholder*="property"]',
      'input[placeholder*="hotel"]',
      '.property-search input',
      '.hotel-search input',
      'input[type="text"]',
      'input[data-test-id="property-search"]',
      'input[data-test-id="hotel-search"]'
    ],
    item: (propertyId: string) => [
      `a[href*="hotel_id=${propertyId}"][target="_blank"]`,
      `a[href*="hotel_id=${propertyId}&"]`,
      `a[href*="hotel_id=${propertyId}"]:contains("${propertyId}")`,
    ],
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
  'Verify your identity',
  'nw-signin-verification',
  'verification-pulse-link',
  'sms-verification-link',
  'Text message (SMS)'
];

export const BOOKING_LOGIN_SUCCESS_URLS = [
  'admin.booking.com',
  'account.business.booking.com',
  'partner'
];

export const BOOKING_LOGIN_EXCLUDE_URLS = [
  'sign-in'
];