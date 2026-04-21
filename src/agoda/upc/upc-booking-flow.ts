import { Browser, Frame, Page } from "puppeteer";
import { delay } from "../../common/delay.js";
import {
  FAILED_REASON,
  setFailedReasonCode,
} from "../../common/failed-reason.js";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { otpCompletionNotifier } from "../../common/otp-completion-notifier.js";
import { progressManager } from "../../common/progress-manager.js";
import { scrapingStateManager } from "../../common/scraping-state.js";
import { takeSuccessScreenshot } from "../../common/screenshot-helper.js";
import { timeoutManager } from "../../common/timeout-manager.js";
import {
  getAgodaOtpCode,
  getYcsPayoutOtpCodes,
} from "../login-system/email-otp-helper.js";
import {
  BOOKING_DETAIL,
  BOOKING_LIST_PAGE,
  BOOKING_RESULT,
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
  /** Last successfully scraped card number digits — used to detect stale widget render on the next booking. */
  lastScrapedCardDigits?: string;
  /**
   * Once-flag to prevent double release. Matches `agoda-retrieval-proxy`'s
   * `isOtpReleasedForRetrieval` pattern but scoped to this UPC phase run.
   */
  otpReleased?: boolean;
}

/**
 * Release the OTP slot so other waiting jobs can use it while this job
 * keeps scraping the remaining reservations. Mirrors the two release points
 * used in `agoda-retrieval-proxy`:
 *   1) right after Get Payout confirms no payout OTP is required, and
 *   2) right after a payout OTP is verified successfully.
 *
 * Follows the same pattern `src/agoda/login-system/login.ts` previously used
 * after a successful login OTP: emit `otpCompletionNotifier.notifyOtpCompleted`
 * ONLY. The scraping worker forwards this as a `job-progress` message with
 * `otpCompleted: true`, and `OtpAwareWorkerPool.handleOtpCompleted` on the
 * parent side performs the actual DB release via `otpManager.releaseOtp`.
 *
 * We intentionally do NOT call `otpStatusManager.releaseOtp` here — doing so
 * from inside the worker causes a duplicate release attempt by the parent
 * pool (visible in logs as "Failed to release OTP ... - not currently owner").
 *
 * Guarded by `session.otpReleased` so each UPC phase only notifies once.
 */
export function releaseUpcOtp(
  jobId: string | undefined,
  session: UpcCollectSession | undefined,
  reason: string
): void {
  if (!jobId) return;
  if (session?.otpReleased) return;
  if (session) session.otpReleased = true;
  try {
    otpCompletionNotifier.notifyOtpCompleted(jobId);
    // Log after emit so it appears just before the parent-side "OTP released" log.
    void dualLogInfo(`UPC: ✅ OTP release requested — ${reason}`, { jobId });
  } catch (e: unknown) {
    void dualLogError(
      `UPC: error notifying OTP release — ${reason}`,
      e instanceof Error ? e : undefined,
      { jobId }
    );
  }
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

/**
 * After scraping a reservation, the detail sidebar (tab list + UPC widget) remains
 * mounted with the previous booking's data. When we search for the next booking the
 * table re-filters correctly, but the still-open sidebar can swallow the row click
 * or (worse) our scrape can read the previous card before React rebinds.
 *
 * Agoda's panel does NOT respond to the Escape key, so we close it by either:
 *   1. Clicking the explicit `[data-element-name="ycs-booking-detail-close-button"]`
 *      in the panel header, or
 *   2. Clicking the booking search input (focusing the search input closes the panel
 *      in YCS), or
 *   3. As a last resort, reloading the booking list URL.
 */
async function closeBookingDetailSidebarIfOpen(
  page: Page,
  bookingListUrl: string,
  jobId?: string
): Promise<void> {
  const sidebarVisible = async (): Promise<boolean> => {
    try {
      const el = await page.$(BOOKING_DETAIL.TAB_LIST);
      if (!el) return false;
      return await el.isVisible().catch(() => false);
    } catch {
      return false;
    }
  };

  if (!(await sidebarVisible())) return;

  await dualLogInfo(
    "UPC: booking detail sidebar is open — closing before next search",
    { jobId }
  );

  /**
   * Attempt 1: click the panel's explicit close button (data-element-name=
   * "ycs-booking-detail-close-button"). Try every matching button — Agoda
   * sometimes renders multiple (mobile vs desktop variants) and only one is
   * actually interactable.
   */
  try {
    const closeButtons = await page.$$(BOOKING_DETAIL.CLOSE_BUTTON);
    for (const btn of closeButtons) {
      const visible = await btn.isVisible().catch(() => false);
      if (!visible) continue;
      try {
        await btn.click();
        await delay(500);
        if (!(await sidebarVisible())) {
          await dualLogInfo("UPC: sidebar closed via close button", { jobId });
          return;
        }
      } catch {
        /* try next */
      }
    }
  } catch {
    /* fall through */
  }

  /**
   * Attempt 2: focus the booking search input. Clicking into it shifts focus
   * out of the panel and YCS dismisses the detail view.
   */
  try {
    const input = await page.$(BOOKING_LIST_PAGE.SEARCH_INPUT);
    if (input) {
      await input.click({ delay: 20 }).catch(() => {});
      await delay(600);
      if (!(await sidebarVisible())) {
        await dualLogInfo("UPC: sidebar closed via search-input focus", {
          jobId,
        });
        return;
      }
    }
  } catch {
    /* fall through */
  }

  /* Attempt 3: reload the booking list URL — guaranteed fresh state. */
  await dualLogInfo(
    "UPC: sidebar did not close via button/input click — reloading list URL",
    { jobId }
  );
  try {
    const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);
    await page.goto(bookingListUrl, {
      waitUntil: "networkidle2",
      timeout: loadingTimeout,
    });
    await delay(2500);
    await page.waitForSelector(BOOKING_LIST_PAGE.SEARCH_INPUT, {
      visible: true,
      timeout: 30000,
    });
  } catch (e: unknown) {
    await dualLogError(
      "UPC: failed to reload list to close sidebar",
      e instanceof Error ? e : undefined,
      { jobId }
    );
  }
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
    /**
     * Search input is visible — but the detail sidebar (from the *previous* booking)
     * may also still be open. Close it before the next search so the row click for the
     * new booking is not absorbed by the sidebar and reliably re-opens the detail panel.
     */
    await closeBookingDetailSidebarIfOpen(page, bookingListUrl, jobId);
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
  jobId?: string,
  previousCardDigits?: string
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

  /**
   * After `reSearchAndNavigateToPayout` / switching bookings the widget container can be visible
   * while the card-number cell still renders the *previous* booking's masked value (or is empty).
   * Poll for up to 25s until the card-number <p> has digits AND differs from the previous
   * booking's card (when known). Mirrors the retrieval proxy's "widget hydrated" behaviour
   * but with an extra freshness check so we never save the wrong booking's card.
   */
  const READY_DEADLINE = Date.now() + 25000;
  while (Date.now() < READY_DEADLINE) {
    const cardNumberText = await page
      .evaluate((selectors) => {
        const cn = document.querySelector(selectors.CARD_NUMBER);
        return cn?.textContent?.trim() || "";
      }, UPC_WIDGET)
      .catch(() => "");

    const currentDigits = cardNumberText.replace(/\D/g, "");
    if (currentDigits.length >= 4) {
      if (!previousCardDigits || currentDigits !== previousCardDigits) {
        break;
      }
      await dualLogInfo(
        "UPC: widget still showing previous booking's card — waiting for re-render",
        {
          jobId,
          bookingId,
          staleTail: currentDigits.slice(-4),
        }
      );
    }
    await delay(500);
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

  const cnDigits = (upcData.cardNumber || "").replace(/\D/g, "");
  if (!cnDigits || cnDigits.length < 4) {
    await dualLogInfo(
      "UPC: widget present but card number not populated yet — skipping",
      { jobId, bookingId, cardNumberRaw: upcData.cardNumber }
    );
    return null;
  }
  if (previousCardDigits && cnDigits === previousCardDigits) {
    /**
     * Safety net: scrape timed out while still showing the previous booking's card.
     * Returning null is far safer than saving the wrong booking's card info.
     */
    await dualLogError(
      "UPC: widget never re-rendered for current booking — refusing to save previous booking's card",
      undefined,
      {
        jobId,
        bookingId,
        staleTail: cnDigits.slice(-4),
      }
    );
    return null;
  }

  await dualLogInfo(
    `UPC: scraped card for booking ${bookingId}`,
    {
      jobId,
      bookingId,
      cardHolderName: upcData.cardHolderName,
      cardNumberTail: cnDigits.slice(-4),
      expirationDate: upcData.expirationDate,
    }
  );

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
 * If OTP inputs are already in the DOM, does nothing.
 *
 * Mirrors agoda-retrieval-proxy `handleOtpVerification`: waitForSelector + Puppeteer click +
 * evaluate fallbacks (parent / mouse events).
 */
async function selectEmailOtpChannelIfChooserVisible(
  frame: Frame,
  jobId?: string
): Promise<void> {
  const otpInputsPresent = (): Promise<boolean> =>
    frame.evaluate(
      () =>
        !!(
          document.querySelector('input[data-cy="otp-box-0"]') ||
          document.querySelector('[data-cy="otp-0"]')
        )
    );

  if (await otpInputsPresent()) {
    return;
  }

  try {
    await frame.waitForSelector('[data-cy="verify-otp-panel"]', {
      timeout: 20000,
    });
  } catch {
    /* panel may use different timing — continue */
  }

  const emailOptionSelectors = [
    UNIVERSAL_LOGIN_OTP.OPTION_EMAIL,
    'div[data-cy="otp-option-email"]',
    '[data-cy="email-text"]',
    '[data-cy="email-option"]',
  ];

  const clickEmailViaEvaluate = async (
    selector: string
  ): Promise<boolean> => {
    return frame.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return false;

      const row =
        (el.closest(
          '[data-cy="otp-option-email"]'
        ) as HTMLElement | null) ||
        (sel.includes("otp-option-email") ? el : null);
      const target = (row || el) as HTMLElement;

      try {
        target.click();
      } catch {
        /* ignore */
      }
      const inner = target.querySelector(
        '[data-cy="email-text"]'
      ) as HTMLElement | null;
      if (inner) inner.click();

      const parent = target.parentElement;
      parent?.click();

      const events = [
        new MouseEvent("mouseover", { bubbles: true, cancelable: true }),
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
        new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      ];
      for (const ev of events) {
        target.dispatchEvent(ev);
        parent?.dispatchEvent(ev);
      }
      return true;
    }, selector);
  };

  for (const sel of emailOptionSelectors) {
    try {
      await frame.waitForSelector(sel, { timeout: 8000, visible: true });
    } catch {
      try {
        await frame.waitForSelector(sel, { timeout: 2000 });
      } catch {
        continue;
      }
    }

    if (await otpInputsPresent()) {
      return;
    }

    await dualLogInfo(
      "UPC: verification chooser — attempting via Email",
      { jobId, selector: sel }
    );

    try {
      const handle = await frame.$(sel);
      if (handle) {
        await handle.click({ delay: 50 });
      }
    } catch {
      /* prefer evaluate below */
    }

    const evOk = await clickEmailViaEvaluate(sel);
    if (evOk) {
      await dualLogInfo("UPC: via Email click dispatched (evaluate)", {
        jobId,
        selector: sel,
      });
      await delay(3000);
      if (await otpInputsPresent()) {
        return;
      }
    }
  }

  const stepMs = 400;
  const maxIterations = 60;

  for (let i = 0; i < maxIterations; i++) {
    if (await otpInputsPresent()) {
      return;
    }

    const clicked = await frame.evaluate(() => {
      const row = document.querySelector(
        '[data-cy="otp-option-email"]'
      ) as HTMLElement | null;
      if (!row) return false;
      row.click();
      const text = row.querySelector(
        '[data-cy="email-text"]'
      ) as HTMLElement | null;
      text?.click();
      const events = [
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
        new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      ];
      for (const ev of events) {
        row.dispatchEvent(ev);
      }
      return true;
    });

    if (clicked) {
      await dualLogInfo("UPC: via Email (poll + evaluate)", { jobId });
      await delay(3000);
      if (await otpInputsPresent()) {
        return;
      }
    }

    await delay(stepMs);
  }

  await dualLogInfo(
    "UPC: chooser may be absent or already past — continuing OTP flow",
    { jobId }
  );
}

/**
 * Payout verification uses the same Universal Login iframe as sign-in; the top page or iframe may
 * navigate when verify opens — always re-resolve `iframe[data-cy="ul-app-frame"]` before touching the frame.
 */
async function fillPayoutOtpInFrame(
  page: Page,
  jobId?: string,
  agodaUsername?: string
): Promise<void> {
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

  await frame.waitForFunction(
    () =>
      !!(
        document.querySelector('input[data-cy="otp-box-0"]') ||
        document.querySelector('[data-cy="otp-0"]')
      ),
    { timeout: selectorTimeout }
  );

  const otpVariant = await frame.evaluate(() =>
    document.querySelector('input[data-cy="otp-box-0"]') ? "unified" : "legacy"
  ) as "unified" | "legacy";

  if (jobId) {
    await progressManager.updateJobProgress(
      jobId,
      undefined,
      40,
      "agoda_upc_waiting_for_otp_email",
      undefined
    );
  }

  /**
   * Match `agoda-retriveal-proxy` (`handleOtpVerification`): wait a full 60s after clicking
   * *via Email* before polling Gmail. Agoda's payout OTP can take 20–40s to arrive and
   * fetching too early can pick up an older login-PIN email, which filled the wrong code.
   */
  await dualLogInfo(
    "UPC: waiting 60 seconds for payout OTP email delivery",
    { jobId }
  );
  await delay(60000);
  await dualLogInfo(
    `UPC: fetching OTP(s) from email for payout verification${
      agodaUsername ? ` (to:${agodaUsername})` : ""
    }`
  );

  /**
   * Pull the list of payout OTPs from Gmail, newest → oldest. Agoda sometimes sends
   * multiple codes in quick succession (resend + original, or a stale code cached
   * from an earlier booking) and reports "The OTP code is incorrect" on the wrong
   * one. We iterate candidates until one succeeds.
   */
  let otpCodes: string[] = [];
  let emailFound = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await dualLogInfo(`UPC: payout OTP fetch attempt ${attempt}/3`, { jobId });
    if (agodaUsername) {
      const res = await getYcsPayoutOtpCodes(agodaUsername, 10);
      emailFound = emailFound || res.emailFound;
      otpCodes = res.otpCodes;
    } else {
      const res = await getAgodaOtpCode(10);
      emailFound = emailFound || !!res.emailFound;
      otpCodes = res.otpCode ? [res.otpCode] : [];
    }
    if (otpCodes.length > 0) break;
    if (attempt < 3) {
      await dualLogInfo(
        "UPC: payout OTP not yet available, waiting 10s before retry",
        { jobId }
      );
      await delay(10000);
    }
  }

  if (!emailFound) {
    const err = new Error("Failed to access email for UPC OTP");
    setFailedReasonCode(err, FAILED_REASON.AGODA_OTP_CODE_NOT_FOUND);
    throw err;
  }
  if (otpCodes.length === 0) {
    const err = new Error("UPC OTP not found in recent emails");
    setFailedReasonCode(err, FAILED_REASON.AGODA_OTP_CODE_NOT_FOUND);
    throw err;
  }

  await dualLogInfo(
    `UPC: will try ${otpCodes.length} payout OTP code(s) in order`,
    { jobId, otpCount: otpCodes.length }
  );

  const submitUnified = UNIVERSAL_LOGIN_OTP.SUBMIT_UNIFIED;
  const submitLegacy = UNIVERSAL_LOGIN_OTP.SUBMIT_LEGACY;
  const failedSel = UNIVERSAL_LOGIN_OTP.FAILED_VERIFY;

  const buildInputSelector = (idx: number) =>
    otpVariant === "unified"
      ? `input[data-cy="otp-box-${idx}"]`
      : `[data-cy="otp-${idx}"]`;

  /** Clear all 6 OTP input boxes using the native value setter so React re-renders. */
  const clearOtpInputs = async (f: Frame): Promise<void> => {
    for (let i = 0; i < 6; i++) {
      const sel = buildInputSelector(i);
      try {
        await f.evaluate((s: string) => {
          const input = document.querySelector(s) as HTMLInputElement | null;
          if (!input) return;
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value"
          )?.set;
          if (nativeSetter) nativeSetter.call(input, "");
          else input.value = "";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }, sel);
        await f.focus(sel).catch(() => {});
        await f.click(sel, { clickCount: 3 }).catch(() => {});
        await page.keyboard.press("Delete").catch(() => {});
        await page.keyboard.press("Backspace").catch(() => {});
      } catch {
        /* input may have been replaced mid-clear — next attempt re-queries */
      }
    }
    await delay(200);
  };

  /** Type a single 6-digit code into the OTP boxes. */
  const typeOtp = async (f: Frame, code: string): Promise<void> => {
    const codeDigits = code.split("");
    for (let i = 0; i < 6; i++) {
      const sel = buildInputSelector(i);
      await f.waitForSelector(sel, { timeout: selectorTimeout });
      await f.focus(sel);
      await f.evaluate((s: string) => {
        const input = document.querySelector(s) as HTMLInputElement | null;
        if (input) {
          input.value = "";
          input.focus();
        }
      }, sel);
      await f.type(sel, codeDigits[i], { delay: 150 });
    }
  };

  /** Click Submit OTP button inside the frame. */
  const clickSubmit = async (f: Frame): Promise<boolean> => {
    await f
      .waitForFunction(
        (u: string, l: string) => {
          const b = (document.querySelector(u) ||
            document.querySelector(l)) as HTMLButtonElement | null;
          return !!b && !b.disabled;
        },
        { timeout: selectorTimeout },
        submitUnified,
        submitLegacy
      )
      .catch(() => {});
    return f.evaluate(
      (u: string, l: string) => {
        const b = (document.querySelector(u) ||
          document.querySelector(l)) as HTMLButtonElement | null;
        b?.click();
        return !!b;
      },
      submitUnified,
      submitLegacy
    );
  };

  /**
   * After submit, race: iframe unmounts (success) OR failed-verify banner shows (wrong OTP).
   * Returns "success" | "failed" | "timeout". Polls main page (iframe unmount) and the
   * iframe content (error banner) concurrently for up to 20s.
   */
  const waitForVerifyOutcome = async (
    f: Frame
  ): Promise<"success" | "failed" | "timeout"> => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const iframeEl = await page.$(UNIVERSAL_LOGIN_IFRAME).catch(() => null);
      if (!iframeEl) return "success";
      const vis = await iframeEl.isVisible().catch(() => false);
      if (!vis) return "success";

      const hasFailure = await f
        .evaluate((sel: string) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const txt = (el.textContent || "").toLowerCase();
          return (
            txt.includes("incorrect") ||
            txt.includes("re-enter") ||
            txt.includes("request a new")
          );
        }, failedSel)
        .catch(() => false);
      if (hasFailure) return "failed";

      await delay(500);
    }
    return "timeout";
  };

  let verified = false;
  for (let idx = 0; idx < otpCodes.length; idx++) {
    const code = otpCodes[idx];
    if (code.length !== 6) {
      await dualLogInfo(
        `UPC: skipping invalid OTP length (${code.length}) at index ${idx}`,
        { jobId }
      );
      continue;
    }

    frame = await getUlContentFrame();

    if (idx > 0) {
      await dualLogInfo(
        `UPC: clearing inputs and retrying with next OTP (#${idx + 1}/${
          otpCodes.length
        })`,
        { jobId }
      );
      await clearOtpInputs(frame);
      frame = await getUlContentFrame();
    }

    await dualLogInfo(`UPC: filling payout OTP #${idx + 1}: ${code}`, {
      jobId,
    });
    await typeOtp(frame, code);

    if (jobId && idx === 0) {
      await takeSuccessScreenshot(page, jobId, "upc_otp_digits_filled");
    }

    frame = await getUlContentFrame();
    const submitted = await clickSubmit(frame);
    if (!submitted) {
      throw new Error("UPC: payout OTP submit button not found");
    }

    const outcome = await waitForVerifyOutcome(frame);
    if (outcome === "success") {
      await dualLogInfo(
        `UPC: payout OTP #${idx + 1} accepted — verification complete`,
        { jobId }
      );
      verified = true;
      break;
    }
    if (outcome === "failed") {
      await dualLogInfo(
        `UPC: payout OTP #${idx + 1} rejected by Agoda (incorrect code)`,
        { jobId }
      );
      continue;
    }
    /**
     * timeout — treat conservatively as failed so we try the next OTP. If no more
     * codes remain, the outer check throws AGODA_OTP_CODE_NOT_FOUND.
     */
    await dualLogInfo(
      `UPC: payout OTP #${idx + 1} submit timed out (no success and no error)`,
      { jobId }
    );
  }

  if (!verified) {
    const err = new Error(
      `All ${otpCodes.length} payout OTP code(s) were rejected by Agoda`
    );
    setFailedReasonCode(err, FAILED_REASON.AGODA_OTP_CODE_NOT_FOUND);
    throw err;
  }

  await delay(3000);
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
  const explicit = BOOKING_DETAIL.PAYOUT_TAB.split(", ")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sel of explicit) {
    try {
      const el = await page.$(sel);
      if (el && (await el.isVisible().catch(() => false))) {
        await el.click();
        await dualLogInfo(`UPC: clicked Get payout tab (${sel})`, { jobId });
        await delay(3000);
        return;
      }
    } catch {
      /* try next */
    }
  }

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
  await dualLogInfo("UPC: clicked Get payout tab (text match)", { jobId });
  await delay(3000);
}

/**
 * After payout OTP succeeds, YCS often needs a full search → row → Get payout again before the UPC
 * widget shows card data (same as `reSearchAndNavigateToPayout` on the retrieval branch).
 */
async function reSearchThenOpenGetPayout(
  page: Page,
  bookingListUrl: string,
  bookingId: string,
  jobId?: string
): Promise<boolean> {
  try {
    await dualLogInfo("UPC: re-search after payout OTP, then Get payout again", {
      jobId,
      bookingId,
    });
    await ensureBookingListSearchReady(page, bookingListUrl, jobId);
    await page.waitForSelector(BOOKING_LIST_PAGE.SEARCH_INPUT, {
      visible: true,
      timeout: 20000,
    });

    await page.click(BOOKING_LIST_PAGE.SEARCH_INPUT);
    await delay(300);
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await delay(100);
    await page.keyboard.press("Delete");
    await delay(200);
    await page.keyboard.press("Backspace");
    await delay(200);

    await page.$eval(
      BOOKING_LIST_PAGE.SEARCH_INPUT,
      (input: HTMLInputElement) => {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value"
        )?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(input, "");
        } else {
          input.value = "";
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        if ((input as unknown as { _valueTracker?: { setValue: (v: string) => void } })
          ._valueTracker) {
          (input as unknown as { _valueTracker: { setValue: (v: string) => void } })
            ._valueTracker.setValue("");
        }
      }
    );
    await delay(300);

    await page.type(BOOKING_LIST_PAGE.SEARCH_INPUT, bookingId, { delay: 100 });
    await delay(500);
    await clickSearchButton(page, jobId);
    await delay(2000);

    const rowSel = BOOKING_RESULT.ROW(bookingId);
    try {
      await page.waitForSelector(rowSel, { visible: true, timeout: 15000 });
    } catch {
      await page.waitForFunction(
        (bid: string) => {
          const box = document.querySelector(
            '[data-testid="booking-list-box"]'
          );
          const root = box || document.body;
          return (root.textContent || "").includes(bid);
        },
        { timeout: 15000 },
        bookingId
      );
    }

    const guestSel = BOOKING_RESULT.GUEST_NAME(bookingId);
    const guestEl = await page.$(guestSel);
    if (guestEl && (await guestEl.isVisible().catch(() => false))) {
      await guestEl.click();
    } else {
      const row = await page.$(rowSel);
      if (row) await row.click();
      else {
        const fallback = await page.evaluate((bid: string) => {
          const rows = Array.from(
            document.querySelectorAll(
              '[data-testid="booking-list-box"] tr, table tbody tr'
            )
          );
          for (const r of rows) {
            if ((r.textContent || "").includes(bid)) {
              (r as HTMLElement).click();
              return true;
            }
          }
          return false;
        }, bookingId);
        if (!fallback) {
          throw new Error("UPC: booking row not found after re-search");
        }
      }
    }

    await delay(2000);
    try {
      await page.waitForSelector(BOOKING_DETAIL.TAB_LIST, {
        visible: true,
        timeout: 15000,
      });
    } catch {
      await page.waitForSelector('[role="tablist"], [data-testid*="tab"]', {
        visible: true,
        timeout: 10000,
      });
    }

    await clickGetPayoutTab(page, jobId);
    await delay(2000);
    return true;
  } catch (e: unknown) {
    await dualLogError(
      "UPC: reSearchThenOpenGetPayout failed",
      e instanceof Error ? e : undefined,
      { jobId, bookingId }
    );
    return false;
  }
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

  /**
   * Fast path: poll briefly for the UPC widget or the OTP iframe. When the card
   * shows directly (no verification needed) we return within ~1-3s instead of
   * burning the full 15s + 45s navigation wait. Mirrors the retrieval branch's
   * `Promise.race([networkIdle, upcWidget, ulIframe])` pattern.
   */
  const fastPathDeadline = Date.now() + 15000;
  while (Date.now() < fastPathDeadline) {
    try {
      const upcEl = await page.$(UPC_WIDGET.CONTAINER);
      if (upcEl && (await upcEl.isVisible().catch(() => false))) {
        await dualLogInfo(
          "UPC: payout view resolved directly (fast path — no verification required)",
          { jobId }
        );
        return;
      }
      const iframeEl = await page.$(UNIVERSAL_LOGIN_IFRAME);
      if (iframeEl && (await iframeEl.isVisible().catch(() => false))) {
        await dualLogInfo(
          "UPC: Universal Login iframe detected — proceeding to OTP flow",
          { jobId }
        );
        return;
      }
    } catch {
      /* ignore transient DOM errors during navigation */
    }
    await delay(500);
  }

  await dualLogInfo(
    "UPC: extended wait for first payout verification (Universal Login / new URL may load)",
    { jobId }
  );
  try {
    await page.waitForNavigation({
      waitUntil: "networkidle2",
      timeout: 30000,
    });
  } catch {
    /* no full navigation in SPA — expected sometimes */
  }
  await delay(3000);
}

/**
 * Search by booking ID, open row, payout tab, handle OTP if needed, return UPC data.
 * @param bookingListUrl — same URL used by `openBookingListPage`; required so we can return to the list after viewing a booking detail.
 */
export async function collectUpcForBookingId(
  page: Page,
  bookingListUrl: string,
  bookingId: string,
  agodaUsername: string | undefined,
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

  /**
   * Wait for the *specific* row `tr[data-testid="booking-result-row-<bookingId>"]`
   * so we only click the row matching this booking. Retrieval proxy branch uses
   * the same approach — scanning by textContent can hit fragments inside the still
   * open sidebar and pick the wrong element.
   */
  const rowSel = BOOKING_RESULT.ROW(bookingId);
  const guestSel = BOOKING_RESULT.GUEST_NAME(bookingId);
  try {
    await Promise.race([
      page
        .waitForSelector(rowSel, { visible: true, timeout: 15000 })
        .then(() => dualLogInfo("UPC: booking row appeared", { jobId, bookingId })),
      page
        .waitForNetworkIdle({ idleTime: 500, timeout: 10000 })
        .then(() =>
          dualLogInfo("UPC: network idle after search", { jobId, bookingId })
        ),
      delay(2000),
    ]);
  } catch {
    /* best-effort race — verification below */
  }

  try {
    await page.waitForSelector(rowSel, { visible: true, timeout: 5000 });
  } catch {
    /**
     * Agoda sometimes renders the row without the exact `booking-result-row-<id>`
     * data-testid (older layout). Fall back to any row containing the booking id.
     */
    try {
      await page.waitForFunction(
        (bid: string) => {
          const box = document.querySelector(
            '[data-testid="booking-list-box"]'
          );
          const root = box || document.body;
          return (root.textContent || "").includes(bid);
        },
        { timeout: 10000 },
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
  }

  /**
   * Prefer the guest-name element inside the specific row (same as retrieval proxy).
   * Puppeteer's `elementHandle.click()` is more reliable than an in-page
   * `document.querySelector(...).click()` because it simulates a trusted mouse event.
   */
  let rowOpened = false;
  try {
    const guestEl = await page.$(guestSel);
    if (guestEl) {
      await guestEl.click();
      await dualLogInfo("UPC: clicked guest name in booking row", {
        jobId,
        bookingId,
      });
      rowOpened = true;
    }
  } catch {
    /* try row next */
  }

  if (!rowOpened) {
    try {
      const rowEl = await page.$(rowSel);
      if (rowEl) {
        await rowEl.click();
        await dualLogInfo("UPC: clicked booking row", { jobId, bookingId });
        rowOpened = true;
      }
    } catch {
      /* fallback below */
    }
  }

  if (!rowOpened) {
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
  }

  /**
   * Verify the detail sidebar actually opened for this booking. If it didn't
   * (e.g. the previous sidebar absorbed the click), retry one more time.
   */
  let sidebarOpen = false;
  try {
    await page.waitForSelector(BOOKING_DETAIL.TAB_LIST, {
      visible: true,
      timeout: 10000,
    });
    sidebarOpen = true;
  } catch {
    /* try one more row click below */
  }

  if (!sidebarOpen) {
    await dualLogInfo(
      "UPC: sidebar did not open after row click — retrying click once",
      { jobId, bookingId }
    );
    try {
      const guestEl = await page.$(guestSel);
      if (guestEl) {
        await guestEl.click();
      } else {
        const rowEl = await page.$(rowSel);
        if (rowEl) await rowEl.click();
      }
    } catch {
      /* give up, fall through */
    }
    try {
      await page.waitForSelector(BOOKING_DETAIL.TAB_LIST, {
        visible: true,
        timeout: 10000,
      });
      sidebarOpen = true;
    } catch {
      /* still not open */
    }
  }

  if (!sidebarOpen) {
    await dualLogError(
      `UPC: booking detail sidebar never opened for ${bookingId}`,
      undefined,
      { jobId, bookingId }
    );
    return null;
  }

  await delay(1500);

  await clickGetPayoutTab(page, jobId);
  await waitAfterGetPayoutForVerificationUi(page, jobId, session);

  const mode = await waitForUpcOrOtpIframe(page, jobId);
  if (mode === "otp") {
    await fillPayoutOtpInFrame(page, jobId, agodaUsername);
    /**
     * OTP was accepted — release the slot now so other queued jobs can use it
     * while this job keeps scraping the remaining reservations. Same pattern
     * as `agoda-retrieval-proxy/retriveal-data.ts` (~line 1711).
     */
    releaseUpcOtp(jobId, session, "after payout OTP verified");
    const reOk = await reSearchThenOpenGetPayout(
      page,
      bookingListUrl,
      bookingId,
      jobId
    );
    if (reOk) {
      await dualLogInfo(
        "UPC: post-OTP re-search complete — settling before UPC scrape",
        { jobId, bookingId }
      );
      await delay(3000);
    } else {
      await dualLogInfo(
        "UPC: post-OTP re-search failed — using extended payout settle + tab retry",
        { jobId, bookingId }
      );
      await waitAfterGetPayoutForVerificationUi(page, jobId, session);
      await delay(5000);
      await clickGetPayoutTab(page, jobId).catch(() => {});
      await delay(3000);
    }
  }
  /**
   * Important: we do NOT release the OTP here on the "no payout OTP needed"
   * path. Observed production issue:
   *   - Booking #1 showed the UPC widget directly (no OTP).
   *   - We released the slot → another job grabbed it and started logging in,
   *     which generated its own Agoda OTP email.
   *   - Booking #2 (same property-job, still running) then required a payout
   *     OTP. Our inbox-scan picked up the OTHER job's freshly-sent OTP email
   *     and submitted it — Agoda accepts account-wide OTPs, so it worked, but
   *     it stole the other job's OTP.
   *
   * Releasing only after a successful `fillPayoutOtpInFrame` avoids this race:
   * once we've verified, Agoda trusts the session for the rest of the phase,
   * so we can safely hand off. If NO booking ever needs an OTP, the slot is
   * released by the end-of-phase safety net in `agoda-upc.ts`.
   */

  const previousCardDigits = session?.lastScrapedCardDigits;
  let data = await scrapeUpcWidgetData(
    page,
    bookingId,
    jobId,
    previousCardDigits
  );
  if (!data?.cardNumber && mode === "otp") {
    await delay(2000);
    await clickGetPayoutTab(page, jobId);
    await delay(3000);
    data = await scrapeUpcWidgetData(page, bookingId, jobId, previousCardDigits);
  }

  const newDigits = (data?.cardNumber || "").replace(/\D/g, "");
  if (session && newDigits.length >= 4) {
    session.lastScrapedCardDigits = newDigits;
  }
  if (session && newDigits.length >= 12) {
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
