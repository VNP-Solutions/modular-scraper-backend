import { Browser, Frame, Page } from "puppeteer";
import { delay } from "../../common/delay.js";
import {
  FAILED_REASON,
  setFailedReasonCode,
} from "../../common/failed-reason.js";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { progressManager } from "../../common/progress-manager.js";
import { scrapingStateManager } from "../../common/scraping-state.js";
import { takeSuccessScreenshot } from "../../common/screenshot-helper.js";
import { timeoutManager } from "../../common/timeout-manager.js";
import { getAgodaOtpCode } from "../login-system/email-otp-helper.js";
import {
  BOOKING_LIST_PAGE,
  UNIVERSAL_LOGIN_IFRAME,
  UNIVERSAL_LOGIN_OTP,
  UPC_WIDGET,
} from "../utils/upc-selectors.js";

export interface UpcWidgetData {
  cardHolderName: string | null;
  cardNumber: string | null;
  expirationDate: string | null;
  cvcCode: string | null;
}

/** Shared across UPC bookings on the same tab: after first payout OTP, Agoda usually skips re-verify. */
export interface UpcCollectSession {
  payoutOtpCompletedOnce?: boolean;
}

/** Default: last year → today (matches wide retrieval window). */
export function calculateDefaultBookingListDateRange(): {
  startDate: string;
  endDate: string;
} {
  const today = new Date();
  const oneYearAgo = new Date(today);
  oneYearAgo.setFullYear(today.getFullYear() - 1);
  const fmt = (d: Date) => {
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const y = d.getFullYear();
    return `${m}/${day}/${y}`;
  };
  return { startDate: fmt(oneYearAgo), endDate: fmt(today) };
}

function convertDateFormat(dateString: string): string {
  let year: string;
  let month: string;
  let day: string;
  if (dateString.includes("/")) {
    const parts = dateString.split("/");
    month = parts[0].padStart(2, "0");
    day = parts[1].padStart(2, "0");
    year = parts[2];
  } else if (dateString.includes("-")) {
    const parts = dateString.split("-");
    year = parts[0];
    month = parts[1].padStart(2, "0");
    day = parts[2].padStart(2, "0");
  } else {
    throw new Error(`Unsupported date format: ${dateString}`);
  }
  return `${day}-${month}-${year}`;
}

function buildBookingUrl(agodaId: string, startDate: string, endDate: string) {
  const a = convertDateFormat(startDate);
  const b = convertDateFormat(endDate);
  return `https://ycs.agoda.com/mldc/en-us/app/reporting/booking/${agodaId}?startDate=${a}&endDate=${b}`;
}

/** Same URL as `openBookingListPage` — use when navigating back from booking detail between UPC iterations. */
export function buildAgodaBookingListUrl(
  agodaId: string,
  startDate: string,
  endDate: string
): string {
  return buildBookingUrl(agodaId, startDate, endDate);
}

async function ensureBookingListSearchReady(
  page: Page,
  bookingListUrl: string,
  jobId?: string
): Promise<void> {
  const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);
  try {
    await page.waitForSelector(BOOKING_LIST_PAGE.SEARCH_INPUT, {
      visible: true,
      timeout: 3000,
    });
    return;
  } catch {
    /* detail view or other route — reload list */
  }

  await dualLogInfo("UPC: restoring booking list view before search", {
    jobId,
    bookingListUrl,
  });
  await page.goto(bookingListUrl, {
    waitUntil: "networkidle2",
    timeout: loadingTimeout,
  });
  await delay(2500);
  await page.waitForSelector(BOOKING_LIST_PAGE.SEARCH_INPUT, {
    visible: true,
    timeout: 30000,
  });
}

/**
 * Opens the Agoda booking list in a new tab and waits until search is usable.
 */
export async function openBookingListPage(
  browser: Browser,
  agodaId: string,
  startDate: string,
  endDate: string,
  jobId?: string
): Promise<Page> {
  const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);
  const url = buildBookingUrl(agodaId, startDate, endDate);
  await dualLogInfo(`UPC: opening booking list`, { jobId, url });

  const newPage = await browser.newPage();
  await newPage.goto(url, {
    waitUntil: "networkidle2",
    timeout: loadingTimeout,
  });
  await newPage.waitForSelector("body", { timeout: loadingTimeout });
  await delay(4000);

  let reservationsFound = false;
  for (let attempt = 0; attempt < 3 && !reservationsFound; attempt++) {
    const hasReservations = await newPage.evaluate(
      () =>
        document.body.textContent?.includes("Reservations") ||
        !!document.querySelector("h2")
    );
    if (hasReservations) {
      reservationsFound = true;
      break;
    }
    await delay(3000);
    await newPage.reload({ waitUntil: "networkidle2", timeout: loadingTimeout });
  }

  if (!reservationsFound) {
    await newPage.close().catch(() => {});
    throw new Error("UPC: could not load Agoda Reservations page");
  }

  try {
    await newPage.waitForSelector(BOOKING_LIST_PAGE.SEARCH_INPUT, {
      visible: true,
      timeout: 30000,
    });
  } catch {
    await newPage.close().catch(() => {});
    throw new Error("UPC: booking search input not found");
  }

  try {
    await newPage.waitForSelector(BOOKING_LIST_PAGE.LIST_BOX, {
      visible: true,
      timeout: 15000,
    });
  } catch {
    await dualLogInfo("UPC: booking-list-box not found, continuing anyway", {
      jobId,
    });
  }

  return newPage;
}

async function clickSearchButton(page: Page, jobId?: string): Promise<void> {
  const selectors = [
    'button[data-element-name="ycs-booking-search-button"]',
    'button[data-element-name="ycs-booking-search-submit"]',
    'button[type="submit"]',
  ];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        const text = await page.evaluate((e) => e.textContent?.trim(), el);
        if (text && /search/i.test(text)) {
          await el.click();
          await dualLogInfo(`UPC: clicked search (${sel})`, { jobId });
          return;
        }
      }
    } catch {
      /* try next */
    }
  }
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const b = buttons.find(
      (btn) =>
        (btn.textContent || "").trim().toLowerCase() === "search" &&
        (btn as HTMLElement).offsetParent !== null
    );
    if (b) {
      (b as HTMLButtonElement).click();
      return true;
    }
    return false;
  });
  if (!clicked) {
    throw new Error("UPC: Search button not found");
  }
  await dualLogInfo("UPC: clicked Search (text match)", { jobId });
}

async function scrapeUpcWidgetData(
  page: Page,
  bookingId: string,
  jobId?: string
): Promise<UpcWidgetData | null> {
  try {
    await page.waitForSelector(UPC_WIDGET.CONTAINER, {
      visible: true,
      timeout: 15000,
    });
  } catch {
    await dualLogInfo("UPC widget not visible", { jobId, bookingId });
    return null;
  }

  const upcData = await page.evaluate((selectors) => {
    const data: UpcWidgetData = {
      cardHolderName: null,
      cardNumber: null,
      expirationDate: null,
      cvcCode: null,
    };
    const gh = document.querySelector(selectors.CARD_HOLDER_NAME);
    const cn = document.querySelector(selectors.CARD_NUMBER);
    const ex = document.querySelector(selectors.EXPIRATION_DATE);
    const cv = document.querySelector(selectors.CVC_CODE);
    if (gh) data.cardHolderName = gh.textContent?.trim() || null;
    if (cn) data.cardNumber = cn.textContent?.trim() || null;
    if (ex) data.expirationDate = ex.textContent?.trim() || null;
    if (cv) data.cvcCode = cv.textContent?.trim() || null;
    return data;
  }, UPC_WIDGET);

  return upcData;
}

/** True when the tab navigated or the iframe context was torn down (common during payout → verify OTP). */
export function isRecoverableUpcNavigationError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("Execution context was destroyed") ||
    msg.includes("Attempted to use detached") ||
    msg.includes("Target closed") ||
    msg.includes("Cannot find context with specified id")
  );
}

/**
 * Full reload of the booking list after context loss so the next `collectUpcForBookingId` attempt
 * starts from a stable YCS list (same pattern as restoring list between bookings).
 */
export async function recoverUpcBookingListTab(
  page: Page,
  bookingListUrl: string,
  jobId?: string
): Promise<void> {
  const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);
  await dualLogInfo("UPC: reloading booking list tab after session/interruption", {
    jobId,
    url: bookingListUrl,
  });
  await page.goto(bookingListUrl, {
    waitUntil: "networkidle2",
    timeout: loadingTimeout,
  });
  await delay(3000);
  await page.waitForSelector(BOOKING_LIST_PAGE.SEARCH_INPUT, {
    visible: true,
    timeout: 35000,
  });
}

/**
 * When Agoda shows "Select a verification method" (Email vs SMS), choose Email.
 * If OTP inputs are already visible, does nothing.
 */
async function selectEmailOtpChannelIfChooserVisible(
  frame: Frame,
  jobId?: string
): Promise<void> {
  const stepMs = 400;
  const maxIterations = 45;

  for (let i = 0; i < maxIterations; i++) {
    const otp0 = await frame.$(UNIVERSAL_LOGIN_OTP.FIRST_INPUT);
    if (otp0 && (await otp0.isVisible().catch(() => false))) {
      return;
    }

    const emailOption = await frame.$(UNIVERSAL_LOGIN_OTP.OPTION_EMAIL);
    if (emailOption && (await emailOption.isVisible().catch(() => false))) {
      await dualLogInfo(
        "UPC: verification method chooser — clicking via Email",
        { jobId }
      );
      await emailOption.click();
      await delay(2000);
      return;
    }

    await delay(stepMs);
  }
}

/**
 * Payout verification uses the same Universal Login iframe as sign-in; the top page or iframe may
 * navigate when verify opens — always re-resolve `iframe[data-cy="ul-app-frame"]` before touching the frame.
 */
async function fillPayoutOtpInFrame(page: Page, jobId?: string): Promise<void> {
  const selectorTimeout = await timeoutManager.getSelectorTimeout(jobId);

  const getUlContentFrame = async (): Promise<Frame> => {
    const frameEl = await page.waitForSelector(UNIVERSAL_LOGIN_IFRAME, {
      timeout: selectorTimeout,
    });
    const f = await frameEl?.contentFrame();
    if (!f) {
      throw new Error("UPC: OTP iframe has no content frame");
    }
    return f;
  };

  let frame = await getUlContentFrame();
  await selectEmailOtpChannelIfChooserVisible(frame, jobId);
  await delay(2000);
  frame = await getUlContentFrame();

  await frame.waitForSelector(UNIVERSAL_LOGIN_OTP.FIRST_INPUT, {
    timeout: selectorTimeout,
  });

  if (jobId) {
    await progressManager.updateJobProgress(
      jobId,
      undefined,
      40,
      "agoda_upc_waiting_for_otp_email",
      undefined
    );
  }

  await delay(60000);
  await dualLogInfo("UPC: fetching OTP from email for payout verification");

  let otpResult: { otpCode?: string | null; emailFound?: boolean } | null =
    null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    otpResult = await getAgodaOtpCode(5);
    if (otpResult?.otpCode) break;
    await delay(10000);
  }

  if (!otpResult?.emailFound) {
    const err = new Error("Failed to access email for UPC OTP");
    setFailedReasonCode(err, FAILED_REASON.AGODA_OTP_CODE_NOT_FOUND);
    throw err;
  }
  if (!otpResult.otpCode) {
    const err = new Error("UPC OTP not found in recent emails");
    setFailedReasonCode(err, FAILED_REASON.AGODA_OTP_CODE_NOT_FOUND);
    throw err;
  }

  const digits = otpResult.otpCode.split("");
  if (digits.length !== 6) {
    throw new Error(`UPC OTP length invalid: ${digits.length}`);
  }

  frame = await getUlContentFrame();

  for (let i = 0; i < 6; i++) {
    const inputSelector = `input[data-cy="otp-box-${i}"]`;
    await frame.waitForSelector(inputSelector, { timeout: selectorTimeout });
    await frame.focus(inputSelector);
    await frame.evaluate((sel: string) => {
      const input = document.querySelector(sel) as HTMLInputElement;
      if (input) {
        input.value = "";
        input.focus();
      }
    }, inputSelector);
    await frame.type(inputSelector, digits[i], { delay: 150 });
  }

  if (jobId) {
    await takeSuccessScreenshot(page, jobId, "upc_otp_digits_filled");
  }

  frame = await getUlContentFrame();

  await frame.waitForFunction(
    () => {
      const button = document.querySelector(
        'button[data-cy="unified-auth-otp-continue-button"]'
      ) as HTMLButtonElement;
      return button && !button.disabled;
    },
    { timeout: selectorTimeout }
  );

  const btn = await frame.waitForSelector(
    'button[data-cy="unified-auth-otp-continue-button"]',
    { timeout: selectorTimeout }
  );
  if (btn) await btn.click();
  await delay(5000);
}

/**
 * After opening payout, either UPC appears or Universal Login iframe for OTP.
 * Polls so first-time payout verification (OTP iframe) is not cut off by a short race.
 */
async function waitForUpcOrOtpIframe(
  page: Page,
  jobId?: string
): Promise<"upc" | "otp"> {
  /** First-time payout verification can take a long time (redirect + Universal Login iframe). */
  const maxMs = 120000;
  const stepMs = 500;
  const deadline = Date.now() + maxMs;

  while (Date.now() < deadline) {
    try {
      const upcEl = await page.$(UPC_WIDGET.CONTAINER);
      if (upcEl) {
        const visible = await upcEl.isVisible().catch(() => false);
        if (visible) {
          await dualLogInfo("UPC: payout view resolved: upc", { jobId });
          return "upc";
        }
      }
      const iframeEl = await page.$(UNIVERSAL_LOGIN_IFRAME);
      if (iframeEl) {
        const visible = await iframeEl.isVisible().catch(() => false);
        if (visible) {
          await dualLogInfo("UPC: payout view resolved: otp", { jobId });
          return "otp";
        }
      }
    } catch (pollErr: unknown) {
      if (isRecoverableUpcNavigationError(pollErr)) {
        await delay(stepMs * 2);
        continue;
      }
      throw pollErr;
    }
    await delay(stepMs);
  }

  try {
    const hasUpc = await page.$(UPC_WIDGET.CONTAINER);
    if (hasUpc && (await hasUpc.isVisible().catch(() => false))) {
      await dualLogInfo("UPC: payout view resolved: upc (late)", { jobId });
      return "upc";
    }
    const hasIframe = await page.$(UNIVERSAL_LOGIN_IFRAME);
    if (hasIframe && (await hasIframe.isVisible().catch(() => false))) {
      await dualLogInfo("UPC: payout view resolved: otp (late)", { jobId });
      return "otp";
    }
  } catch {
    /* ignore */
  }

  await dualLogInfo("UPC: neither widget nor iframe after extended wait", {
    jobId,
  });
  return "upc";
}

async function clickGetPayoutTab(page: Page, jobId?: string): Promise<void> {
  const clicked = await page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll(
        'button[role="tab"], [role="tab"], button, a[role="tab"]'
      )
    ) as HTMLElement[];
    const el = candidates.find((c) => {
      const t = (c.textContent || "").trim();
      return (
        /get payout/i.test(t) ||
        (t.toLowerCase().includes("upc") && t.length < 40)
      );
    });
    if (el) {
      el.click();
      return true;
    }
    return false;
  });
  if (!clicked) {
    throw new Error("UPC: Get payout (UPC) tab not found");
  }
  await dualLogInfo("UPC: clicked Get payout tab", { jobId });
  await delay(3000);
}

/**
 * After Get payout, Agoda often navigates or loads Universal Login in an iframe — give the
 * browser time before we poll or touch DOM, or we destroy the verification context too early.
 */
async function waitAfterGetPayoutForVerificationUi(
  page: Page,
  jobId: string | undefined,
  session: UpcCollectSession | undefined
): Promise<void> {
  if (session?.payoutOtpCompletedOnce) {
    await dualLogInfo(
      "UPC: short wait after Get payout (payout verification already completed this session — card usually shows directly)",
      { jobId }
    );
    await delay(3500);
    return;
  }

  await dualLogInfo(
    "UPC: extended wait for first payout verification (Universal Login / new URL may load)",
    { jobId }
  );
  await delay(15000);
  try {
    await page.waitForNavigation({
      waitUntil: "networkidle2",
      timeout: 45000,
    });
  } catch {
    /* no full navigation in SPA — expected sometimes */
  }
  await delay(8000);
}

/**
 * Search by booking ID, open row, payout tab, handle OTP if needed, return UPC data.
 * @param bookingListUrl — same URL used by `openBookingListPage`; required so we can return to the list after viewing a booking detail.
 */
export async function collectUpcForBookingId(
  page: Page,
  bookingListUrl: string,
  bookingId: string,
  _agodaUsername: string | undefined,
  jobId?: string,
  session?: UpcCollectSession
): Promise<UpcWidgetData | null> {
  await scrapingStateManager.waitWhilePaused();
  if (!scrapingStateManager.isRunning()) {
    throw new Error("Scraping stopped during UPC collection");
  }

  await dualLogInfo(`UPC: searching booking ${bookingId}`, { jobId, bookingId });

  await ensureBookingListSearchReady(page, bookingListUrl, jobId);

  await page.waitForSelector(BOOKING_LIST_PAGE.SEARCH_INPUT, {
    visible: true,
    timeout: 20000,
  });

  await page.click(BOOKING_LIST_PAGE.SEARCH_INPUT);
  await delay(200);
  await page.evaluate((sel: string) => {
    const input = document.querySelector(sel) as HTMLInputElement;
    if (input) {
      input.focus();
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, BOOKING_LIST_PAGE.SEARCH_INPUT);
  await page.type(BOOKING_LIST_PAGE.SEARCH_INPUT, bookingId, { delay: 80 });
  await delay(400);

  await clickSearchButton(page, jobId);
  await delay(2000);

  try {
    await page.waitForFunction(
      (bid: string) => {
        const box = document.querySelector(
          '[data-testid="booking-list-box"]'
        );
        const root = box || document.body;
        return (root.textContent || "").includes(bid);
      },
      { timeout: 20000 },
      bookingId
    );
  } catch {
    await dualLogError(
      `UPC: booking row not found for ${bookingId}`,
      undefined,
      { jobId, bookingId }
    );
    return null;
  }

  const clickedRow = await page.evaluate((bid: string) => {
    const rows = Array.from(
      document.querySelectorAll(
        '[data-testid="booking-list-box"] tr, table tbody tr'
      )
    );
    for (const row of rows) {
      if ((row.textContent || "").includes(bid)) {
        const guest = row.querySelector(
          '[data-testid="guest-name"], p'
        ) as HTMLElement | null;
        if (guest) {
          guest.click();
          return true;
        }
        (row as HTMLElement).click();
        return true;
      }
    }
    return false;
  }, bookingId);

  if (!clickedRow) {
    await dualLogError(`UPC: could not click row for ${bookingId}`, undefined, {
      jobId,
      bookingId,
    });
    return null;
  }

  await delay(2000);
  await page.waitForSelector('[role="tablist"], [data-testid*="tab"]', {
    visible: true,
    timeout: 15000,
  }).catch(() => {});

  await clickGetPayoutTab(page, jobId);
  await waitAfterGetPayoutForVerificationUi(page, jobId, session);

  const mode = await waitForUpcOrOtpIframe(page, jobId);
  if (mode === "otp") {
    await fillPayoutOtpInFrame(page, jobId);
    await delay(5000);
  }

  let data = await scrapeUpcWidgetData(page, bookingId, jobId);
  if (!data?.cardNumber && mode === "otp") {
    await delay(2000);
    await clickGetPayoutTab(page, jobId);
    data = await scrapeUpcWidgetData(page, bookingId, jobId);
  }

  if (
    session &&
    data?.cardNumber &&
    String(data.cardNumber).replace(/\s/g, "").length >= 12
  ) {
    session.payoutOtpCompletedOnce = true;
  }

  return data;
}

export function formatExpiryForStorage(expirationDate: string | null): string {
  if (!expirationDate) return "";
  if (expirationDate.includes("/")) {
    const parts = expirationDate.split("/");
    if (parts.length === 2 && parts[0].length === 4) {
      const [y, m] = parts;
      const shortY = y.length === 4 ? y.slice(-2) : y;
      return `${m}/${shortY}`;
    }
  }
  return expirationDate.trim();
}
