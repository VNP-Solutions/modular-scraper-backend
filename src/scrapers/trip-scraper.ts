import puppeteer, { Browser, Page } from "puppeteer";
import {
  BaseScraper,
  LoginCredentials,
  CaptchaHandlerOptions,
  TwoFactorAuthOptions,
  ScrapingJobParams,
  ScrapingResult,
} from "./base-scraper.js";
import { delay } from "../common/delay.js";
import { timeoutManager } from "../common/timeout-manager.js";
import { dualLogInfo, dualLogWarn } from "../common/log-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { getTripSignInVerificationLinks } from "../otp-verification/trip-signin-verification.js";
import { getTripVccVerificationCodes } from "../otp-verification/trip-vcc-verification.js";
import { jobService, CreateJobItemData } from "../services/job.service.js";
import { parseMaskedEmailPattern } from "../common/masked-email.js";
import { otpStatusService } from "../services/otp-status.service.js";
import { OtpPlatform } from "../models/otp-status.model.js";
import {
  FAILED_REASON,
  hasFailedReasonCode,
  setFailedReasonCode,
  createTripVccBalanceTooLowError,
  createTripVccPasswordWrongError,
  createTripVccOtpCodeNotFoundError,
  createTripVccOtpFailedError,
  createTripOtpLockTimeoutError,
} from "../common/failed-reason.js";

const TRIP_LOGIN_URL = "https://ebooking.trip.com/login/";
const TRIP_VCC_URL =
  "https://ebooking.trip.com/ebkfinancev2/settlement/vcc?microJump=true";
const TRIP_VCC_DETAILS_URL_BASE =
  "https://ebooking.trip.com/ebkfinancev2/settlement/vcc/vcc-details";

/**
 * Selectors verified live against a real vcc-details page (2026-09-21) —
 * the "Card details" panel shows a masked balance/activation date plus a
 * locked "Enter your VCC password to view full details" button. Clicking
 * it opens a password modal; submitting the wrong password shows an inline
 * error ("Wrong password. Double-check and try again.") without closing
 * the modal or navigating away.
 */
const TRIP_VCC_DETAILS_SELECTORS = {
  unlockButton: 'button[he-click="vcc_details_unlock_full_info"]',
  passwordInput: "input#password",
  confirmButton:
    'button[he-click="ebk_biz_idx_monitor_VCCManagement_ConfirmPassword_end_click"]',
  errorText: ".he-trip-kit-ui-form-item-explain-error",
  // The revealed "Card details" panel renders each field as a
  // `.index_infoLabel` + sibling `.index_infoValue` span pair inside an
  // `.index_infoGroup` container. CSS-module hash suffixes on these classes
  // can change between deploys, so match on the stable name segment only.
  revealedInfoGroup: '[class*="infoGroup"]',
  revealedInfoLabel: '[class*="infoLabel"]',
  revealedInfoValue: '[class*="infoValue"]',
};

/**
 * Selectors for the one-time-per-session identity check
 * (`scene=VIEW_VCC_CARD_DETAIL`) shown the first time any VCC card details
 * are revealed in a browser session — verified live (2026-09-21) against
 * `https://ebooking.trip.com/login/verify?type=verify&verifyToken=...&scene=VIEW_VCC_CARD_DETAIL`.
 * 6 separate digit inputs, each with an explicit `aria-label="OTP Input N"`
 * (1-indexed), plus a "Confirm" button that starts disabled and enables
 * once all 6 are filled.
 */
const TRIP_VCC_OTP_SELECTORS = {
  urlFragment: "scene=VIEW_VCC_CARD_DETAIL",
  otpInput: (n: number) => `input[aria-label="OTP Input ${n}"]`,
};

/**
 * Selector for the property name shown in the top header once an account
 * has landed on a specific property's dashboard — verified live
 * (2026-09-21) against `The Watergate Hotel`'s dashboard. Used to confirm
 * a single-property account actually landed on the EXPECTED property
 * (rather than blindly trusting "not on the group list" == "correct
 * property"), since a mismatch here would otherwise silently scrape/reveal
 * VCC data for the wrong hotel.
 */
const TRIP_SINGLE_PROPERTY_SELECTORS = {
  hotelTitleLink: ".he-trip-hotel-title-link",
};

function formatDateYYYYMMDD(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Parses a `MM/DD/YYYY` date string (the format used elsewhere in this codebase). */
function parseMMDDYYYY(dateStr: string): Date {
  const [month, day, year] = dateStr.split("/").map((s) => parseInt(s, 10));
  return new Date(year, month - 1, day);
}

/**
 * Parses the `queryVccOrder` API's date format (e.g. `"2026-07-18
 * 00:00:00"`, verified live 2026-09-21), falling back to "now" for
 * missing/unparseable values so a bad date never blocks saving the rest of
 * the job item.
 */
function parseVccOrderDate(dateStr?: string | null): Date {
  if (!dateStr) return new Date();
  const parsed = new Date(dateStr.replace(" ", "T"));
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * Splits the 180-day window ending at `endDateStr` into calendar-month
 * chunks (`YYYY-MM-DD`), e.g. an end date of 07/31/2026 produces:
 * Feb 1–28, Mar 1–31, Apr 1–30, May 1–31, Jun 1–30, Jul 1–31 (2026).
 * The `queryVccOrder` API is queried once per chunk since Trip.com's own
 * date pickers behave the same way (one calendar month at a time).
 */
function computeVccDateChunks(
  endDateStr: string,
  daysBack = 180
): Array<{ beginCheckInDate: string; endCheckInDate: string }> {
  const endDate = parseMMDDYYYY(endDateStr);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - daysBack);

  const chunks: Array<{ beginCheckInDate: string; endCheckInDate: string }> =
    [];
  let cursor = new Date(
    startDate.getFullYear(),
    startDate.getMonth(),
    startDate.getDate()
  );

  while (cursor <= endDate) {
    const chunkStart = new Date(cursor);
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
    const chunkEnd = monthEnd < endDate ? monthEnd : new Date(endDate);

    chunks.push({
      beginCheckInDate: formatDateYYYYMMDD(chunkStart),
      endCheckInDate: formatDateYYYYMMDD(chunkEnd),
    });

    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }

  return chunks;
}

/**
 * Types into the currently-focused element one character at a time with a
 * randomized per-keystroke delay (instead of Puppeteer's `page.type()`
 * fixed `delay`, which types every character at the exact same interval —
 * an easy automation tell). Caller must focus/click the target field first.
 */
async function typeWithRandomDelay(
  page: Page,
  text: string,
  minDelayMs = 25,
  maxDelayMs = 100
): Promise<void> {
  for (const char of text) {
    const delayMs =
      Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1)) + minDelayMs;
    await page.keyboard.type(char, { delay: delayMs });
  }
}

/**
 * Waits a random duration between `minMs` and `maxMs` — used between
 * back-to-back API calls (e.g. the per-month VCC order queries) instead of
 * a fixed delay, since firing requests at an exact, identical interval is
 * an easy automation tell.
 */
async function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await delay(ms);
}

/**
 * Selectors verified live against https://ebooking.trip.com/login/ (2026-09-21).
 *
 * IMPORTANT: the page reuses the same `id` between a wrapper `<div>` and the real
 * `<input>` inside it (e.g. `id="rc_select_0"` and `id="password-input"` each match
 * TWO elements on the page). Selecting by `id` is therefore ambiguous — `name` is the
 * only reliable attribute for grabbing the actual `<input>` to type into.
 */
const TRIP_SELECTORS = {
  usernameInput: 'input[name="username-input"]',
  passwordInput: 'input[name="password-input"]',
  signInButton: "#hotel-login-box-button",
};

/**
 * Selectors verified live against the eBooking "Verify your identity" step
 * (2026-09-21) — shown for some accounts after a successful username/password
 * submission, while the page stays on `/login/`. Defaults to a phone/SMS
 * code entry with an "Email verification" link at the bottom to switch
 * modes; some accounts land directly in email mode instead (no toggle link).
 */
const TRIP_VERIFICATION_SELECTORS = {
  verifyBoxTitle: ".verify-box-title",
  modeToggleLink: ".verify-box-bottom-link",
};

/**
 * Selectors verified live against https://ebooking.trip.com/home/group (2026-09-21)
 * — the "Your Properties" table shown to accounts that manage more than one
 * property. Single-property accounts skip this table entirely and land
 * straight on the per-property dashboard (`/home/oversea`).
 */
const TRIP_GROUP_SELECTORS = {
  groupUrlFragment: "/home/group",
  propertySearchInput: 'input[placeholder="Search by property name"]',
  // Excludes the table's hidden `he-trip-kit-ui-table-measure-row` layout row.
  propertyRow: "tbody tr.he-trip-kit-ui-table-row",
  detailsButtonInRow: "button",
};

const STOPWORDS = new Set(["a", "an", "the", "and", "of", "&"]);

function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

/**
 * Trip.com's group property list often uses a slightly different display
 * name than what's stored on our side (e.g. our "Aldhafra, a Vignette
 * Collection" vs. their "Aldhafra Resort Vignette Collection"). Rather than
 * requiring an exact match, score candidates by token overlap so small
 * wording differences (added "Resort", dropped article, etc.) don't block a
 * legitimate match.
 */
function nameSimilarity(target: string, candidate: string): number {
  const targetTokens = tokenize(target);
  const candidateTokens = new Set(tokenize(candidate));
  if (targetTokens.length === 0 || candidateTokens.size === 0) return 0;

  const targetSet = new Set(targetTokens);
  let overlap = 0;
  for (const token of targetSet) {
    if (candidateTokens.has(token)) overlap++;
  }
  const union = new Set([...targetSet, ...candidateTokens]).size;
  const jaccard = overlap / union;

  // A match on the first significant word (usually the property's
  // distinguishing brand name, e.g. "Aldhafra") is a strong signal on its
  // own, even when overall token overlap is otherwise low.
  const firstTokenMatches = candidateTokens.has(targetTokens[0]);

  return firstTokenMatches ? Math.max(jaccard, 0.5) : jaccard;
}

/**
 * Builds progressively shorter search terms to try against the group
 * property table: the full name first, then the text before the first
 * comma, then just the first significant word. This handles cases where
 * searching by the exact full name (e.g. "Aldhafra, a Vignette Collection")
 * returns zero results because Trip.com's stored name differs slightly.
 */
/**
 * Resolves with the first non-null value produced by `promises`, or `null`
 * once ALL of them have settled without producing one. Unlike `Promise.race`,
 * this won't resolve prematurely just because one branch happened to
 * reject/timeout slightly before a sibling branch was about to succeed —
 * each input promise is expected to catch its own errors and resolve `null`
 * instead of rejecting.
 */
function firstNonNull<T>(promises: Promise<T | null>[]): Promise<T | null> {
  return new Promise((resolve) => {
    let remaining = promises.length;
    let settled = false;
    for (const p of promises) {
      p.then((value) => {
        if (settled) return;
        if (value !== null) {
          settled = true;
          resolve(value);
          return;
        }
        remaining--;
        if (remaining === 0 && !settled) {
          settled = true;
          resolve(null);
        }
      });
    }
  });
}

function buildPropertySearchCandidates(propertyName: string): string[] {
  const trimmed = propertyName.trim();
  const candidates: string[] = [trimmed];

  const commaIndex = trimmed.indexOf(",");
  if (commaIndex > 0) {
    candidates.push(trimmed.slice(0, commaIndex).trim());
  }

  const firstWord = trimmed.split(/\s+/)[0]?.replace(/[,.]/g, "");
  if (firstWord && firstWord.length > 2) {
    candidates.push(firstWord);
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

export class TripScraper extends BaseScraper {
  constructor() {
    super("trip", TRIP_LOGIN_URL);
  }

  async setupBrowser(
    jobId?: string,
    _loginEmail?: string
  ): Promise<{ browser: Browser; page: Page }> {
    let browser: Browser | null = null;

    try {
      await this.logInfo("Setting up Trip.com browser");

      const { loading: loadingTimeout, selector: selectorTimeout } =
        await timeoutManager.getTimeoutConfig(jobId);

      // Launch a real local Chrome directly (no more Browserless) with
      // headless:false, in both production and development. On the server
      // this now renders onto the VNC-backed virtual display (make sure
      // the `DISPLAY` env var the Node process sees points at that virtual
      // display, and that the Xvfb/VNC screen resolution is at least
      // 1920x1080 — `--start-maximized` only maximizes to whatever size
      // the virtual display actually is). This sidesteps the whole
      // Browserless-session "Allow Notifications" card issue investigated
      // 2026-09-22 (it only ever showed up in Browserless's ephemeral
      // remote sessions, never in a locally-launched Chrome), so no
      // Browserless-specific workarounds (live URL, stealth/humanlike
      // launch flags — those were Browserless's own proprietary options,
      // not real Puppeteer ones) are needed here anymore.
      browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: [
          "--start-maximized",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--no-first-run",
          "--no-default-browser-check",
        ],
      });

      const page: Page = await browser.newPage();

      // Cheap defensive measure kept from the Browserless investigation:
      // pre-grant the notifications permission so `Notification.permission`
      // never reads "default" for this origin, in case Trip.com's own
      // "Allow Notifications" card can still show up in some
      // fresh-profile scenario even outside Browserless (e.g. no
      // persistent `userDataDir` configured for these launches).
      try {
        await browser
          .defaultBrowserContext()
          .overridePermissions(new URL(TRIP_LOGIN_URL).origin, [
            "notifications",
          ]);
      } catch (permError) {
        await this.logWarn(
          "Trip.com: failed to pre-grant the notifications permission",
          permError
        );
      }

      await page.setDefaultNavigationTimeout(loadingTimeout);
      await page.setDefaultTimeout(selectorTimeout);

      await this.navigateToLogin(page, loadingTimeout, selectorTimeout);

      await this.logInfo("Trip.com browser setup completed");
      return { browser, page };
    } catch (error) {
      await this.logError("Trip.com browser setup failed", error);
      if (browser) {
        try {
          await browser.close();
        } catch {
          // ignore cleanup error, original error is what matters
        }
      }
      throw error;
    }
  }

  /**
   * Navigate to the eBooking login page and wait for the (client-rendered) login
   * form to actually mount — `domcontentloaded`/`networkidle2` alone isn't enough
   * since the form is rendered by a React SPA after several JS chunks load.
   */
  private async navigateToLogin(
    page: Page,
    loadingTimeout: number,
    selectorTimeout: number
  ): Promise<void> {
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await dualLogInfo(
          `Trip.com: navigating to login page (attempt ${attempt}/${maxRetries})`
        );

        await page.goto(TRIP_LOGIN_URL, {
          waitUntil: "networkidle2",
          timeout: loadingTimeout,
        });

        // Wait for the actual form fields to be mounted and visible.
        await page.waitForSelector(TRIP_SELECTORS.usernameInput, {
          visible: true,
          timeout: selectorTimeout,
        });
        await page.waitForSelector(TRIP_SELECTORS.passwordInput, {
          visible: true,
          timeout: selectorTimeout,
        });
        await page.waitForSelector(TRIP_SELECTORS.signInButton, {
          visible: true,
          timeout: selectorTimeout,
        });

        await dualLogInfo("Trip.com: login page fully loaded");
        return;
      } catch (navError: any) {
        await dualLogWarn(`Trip.com: navigation attempt ${attempt} failed`, {
          attempt,
          error: navError?.message,
        });

        if (attempt === maxRetries) throw navError;
        await delay(2000);
      }
    }
  }

  async login(credentials: LoginCredentials): Promise<void> {
    if (!this.page || !this.browser) throw new Error("Browser not initialized");

    try {
      await this.logInfo("Starting Trip.com login process");

      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        throw new Error("Scraping was stopped during login");
      }

      const page = this.page;

      // Username field is a searchable combobox (rc-select) — click to focus first.
      await page.waitForSelector(TRIP_SELECTORS.usernameInput, { visible: true });
      await page.click(TRIP_SELECTORS.usernameInput);
      await typeWithRandomDelay(page, credentials.email);

      await page.waitForSelector(TRIP_SELECTORS.passwordInput, { visible: true });
      await page.click(TRIP_SELECTORS.passwordInput);
      await typeWithRandomDelay(page, credentials.password);

      await this.takeScreenshot("trip-login-form-filled");

      await page.waitForSelector(TRIP_SELECTORS.signInButton, { visible: true });
      await page.click(TRIP_SELECTORS.signInButton);

      await this.logInfo("Trip.com sign-in submitted, waiting for result");

      // The login page is a client-rendered SPA. Two outcomes are possible
      // after submitting credentials, both verified live (2026-09-21):
      //  - Trusted accounts navigate away from `/login/` immediately.
      //  - Other accounts stay on `/login/` but the page swaps in a
      //    "Verify your identity" step (phone SMS or email magic-link) —
      //    handled separately in handle2FA().
      // Race both signals (first one to actually succeed wins); only a
      // genuine timeout on both means failure (invalid credentials, or an
      // unhandled error state).
      const loginResult =
        (await firstNonNull<"success" | "verification_required">([
          page
            .waitForFunction(
              () => !window.location.pathname.includes("/login"),
              { timeout: 20000 }
            )
            .then(() => "success" as const)
            .catch(() => null),
          page
            .waitForSelector(TRIP_VERIFICATION_SELECTORS.verifyBoxTitle, {
              visible: true,
              timeout: 20000,
            })
            .then(() => "verification_required" as const)
            .catch(() => null),
        ])) ?? "timeout";

      if (loginResult === "timeout") {
        await this.takeScreenshot("trip-login-error");
        throw new Error(
          "Trip.com login did not leave the login page and no verification step appeared — credentials may be invalid"
        );
      }

      if (loginResult === "verification_required") {
        await this.logInfo(
          "Trip.com login requires an identity verification step; deferring to handle2FA()"
        );
        return;
      }

      await this.logInfo("Trip.com login completed successfully");
    } catch (error) {
      await this.logError("Trip.com login failed", error);
      throw error;
    }
  }

  async handleCaptcha(_options?: CaptchaHandlerOptions): Promise<boolean> {
    // No CAPTCHA was observed on the login page while verifying selectors.
    // Revisit this if Trip.com starts challenging automated sign-ins.
    await this.logInfo("Captcha handling for Trip.com (not yet required)");
    return true;
  }

  /**
   * Handles the eBooking "Verify your identity" step (verified live
   * 2026-09-21). This step defaults to a phone/SMS code, with an "Email
   * verification" link at the bottom to switch modes — some accounts land
   * directly in email mode instead (no toggle link shown).
   *
   * Trip's email verification is a magic link, not a numeric code: the
   * "Verify a recent sign-in" email contains a "Verify it's me" link, and
   * visiting that link (in this same browser session) completes the
   * verification — nothing gets typed into the on-page code input for this
   * flow.
   */
  async handle2FA(_options?: TwoFactorAuthOptions): Promise<boolean> {
    if (!this.page || !this.browser) return false;
    const page = this.page;

    try {
      const verifyBoxShown = await page
        .waitForSelector(TRIP_VERIFICATION_SELECTORS.verifyBoxTitle, {
          visible: true,
          timeout: 8000,
        })
        .then(() => true)
        .catch(() => false);

      if (!verifyBoxShown) {
        await this.logInfo(
          "Trip.com: no identity verification step shown, skipping 2FA"
        );
        return true;
      }

      await this.logInfo("Trip.com: identity verification step detected");
      await this.takeScreenshot("trip-verify-identity-shown");

      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        const err = new Error("Scraping was stopped during identity verification");
        setFailedReasonCode(err, FAILED_REASON.SCRAPING_STOPPED);
        throw err;
      }

      // Default landing is phone/SMS mode with an "Email verification"
      // toggle at the bottom. If that toggle is present, click it to switch
      // to email mode. If it's absent (or already reads something else),
      // we're already in email mode — nothing to do.
      const toggleText = await page
        .$eval(TRIP_VERIFICATION_SELECTORS.modeToggleLink, (el) =>
          el.textContent?.trim()
        )
        .catch(() => null);

      if (toggleText === "Email verification") {
        await dualLogInfo(
          'Trip.com: clicking "Email verification" to switch verification modes'
        );
        await page.click(TRIP_VERIFICATION_SELECTORS.modeToggleLink);
        await delay(1500);
      } else {
        await dualLogInfo(
          'Trip.com: "Email verification" toggle not found/already switched — assuming email mode is already active',
          { toggleText }
        );
      }

      // Confirm we actually landed on the "link sent" confirmation text
      // before committing to the long wait below — catches an unexpected
      // 3rd UI state early instead of waiting 90s+ and failing later.
      const emailModeConfirmed = await page
        .waitForFunction(
          () =>
            document.body.textContent?.includes(
              "Use this link to confirm it's really you"
            ) ?? false,
          { timeout: 10000 }
        )
        .then(() => true)
        .catch(() => false);

      if (!emailModeConfirmed) {
        await this.takeScreenshot("trip-email-verification-mode-unconfirmed");
        const err = new Error(
          "Trip.com: expected the 'verification link sent' confirmation text but didn't see it — unrecognized verification UI state"
        );
        setFailedReasonCode(err, FAILED_REASON.TRIP_VERIFICATION_UI_UNRECOGNIZED);
        throw err;
      }

      await this.takeScreenshot("trip-email-verification-mode");

      // This confirmation screen also shows a masked version of the
      // destination email (verified live 2026-09-21: "We've sent a
      // verification link to ard****hyattfinance.com. Use this link to
      // confirm it's really you." — note this screen hides the `@` itself
      // inside the masked run, unlike the VCC OTP screen's convention).
      // Parse it into a regex so the Gmail lookup below can prefer a
      // candidate whose real `To` header actually matches, instead of
      // blindly trusting "newest email matching from+subject" when
      // multiple properties could be verifying around the same time.
      const signinPageText = await page
        .evaluate(() => document.body.textContent || "")
        .catch(() => "");
      const expectedSigninRecipientPattern =
        parseMaskedEmailPattern(signinPageText);

      if (expectedSigninRecipientPattern) {
        await this.logInfo(
          "Trip.com: parsed expected recipient pattern from the masked email shown on the verification screen",
          { pattern: expectedSigninRecipientPattern.source }
        );
      } else {
        await this.logWarn(
          "Trip.com: could not find/parse a masked email on the verification screen — proceeding without a recipient cross-check"
        );
      }

      // Every Trip.com job polls the SAME shared Gmail inbox for
      // verification emails/links — only one job may actively be waiting
      // on/consuming it at a time, or two concurrent jobs could each grab
      // (or misinterpret) the other's email. Occupy the shared lock
      // (`otp_statuses`, platform `trip.com`) before starting to wait;
      // always release it in `finally` below regardless of how this
      // attempt ends, so a failed job never leaves every other Trip job
      // permanently stuck.
      const otpLockJobId = this.jobId || `standalone-${Date.now()}`;
      const otpLockAcquired = await otpStatusService.waitAndAcquire(
        OtpPlatform.Trip,
        otpLockJobId,
        {
          onWaiting: async (elapsedMs) => {
            await this.logInfo(
              `Trip.com: waiting for the shared email-verification lock (another job is currently using it) — ${Math.round(
                elapsedMs / 1000
              )}s elapsed`
            );
          },
        }
      );

      if (!otpLockAcquired) {
        throw createTripOtpLockTimeoutError();
      }

      await this.logInfo(
        "Trip.com: acquired the shared email-verification lock"
      );

      try {
        // The verification email can take a little while to arrive.
        const initialWaitMs = 90_000; // ~1.5 minutes, per confirmed real timing
        await this.logInfo(
          `Trip.com: waiting ${Math.round(initialWaitMs / 1000)}s for the verification email to arrive`
        );
        // A small buffer before "now" so we don't miss an email that was
        // sent a moment before this exact instant landed.
        const sinceMs = Date.now() - 30_000;
        await delay(initialWaitMs);

        // Poll for the email(s) to arrive — this only retries the *arrival*
        // check (Gmail may take a moment to receive it), not the navigation
        // below. Once at least one candidate link exists, stop polling and
        // grab up to 3 distinct candidates at once (covers the case where a
        // resend or a near-simultaneous attempt left more than one usable
        // link within the sinceMs window).
        const maxPollAttempts = 3;
        const pollDelayMs = 30_000;
        let verifyLinks: string[] = [];

        for (let attempt = 1; attempt <= maxPollAttempts; attempt++) {
          await scrapingStateManager.waitWhilePaused();
          if (!scrapingStateManager.isRunning()) {
            const err = new Error("Scraping was stopped during identity verification");
            setFailedReasonCode(err, FAILED_REASON.SCRAPING_STOPPED);
            throw err;
          }

          await this.logInfo(
            `Trip.com: checking email for the sign-in verification link (attempt ${attempt}/${maxPollAttempts})`
          );
          verifyLinks = await getTripSignInVerificationLinks(
            sinceMs,
            3,
            expectedSigninRecipientPattern ?? undefined
          );
          if (verifyLinks.length > 0) break;

          if (attempt < maxPollAttempts) {
            await delay(pollDelayMs);
          }
        }

        if (verifyLinks.length === 0) {
          await this.takeScreenshot("trip-verification-email-not-found");
          const err = new Error(
            "Trip.com: could not find the sign-in verification email/link after retries"
          );
          setFailedReasonCode(err, FAILED_REASON.TRIP_VERIFICATION_LINK_NOT_FOUND);
          throw err;
        }

        await this.logInfo(
          `Trip.com: found ${verifyLinks.length} verification link candidate(s), will try each in order until one completes sign-in`
        );

        // Try each candidate link in turn — if one doesn't get us off /login
        // (expired/already used/etc.), fall through to the next candidate
        // instead of failing immediately.
        let verificationSucceeded = false;

        for (let i = 0; i < verifyLinks.length; i++) {
          const verifyLink = verifyLinks[i];
          await this.logInfo(
            `Trip.com: navigating to verification link candidate ${i + 1}/${verifyLinks.length}`
          );

          try {
            await page.goto(verifyLink, {
              waitUntil: "networkidle2",
              timeout: 30000,
            });
          } catch (navError: any) {
            // Trip's tracking-redirect link chain doesn't always fire a clean
            // "load" event for Puppeteer's navigation wait — the important
            // thing is where we end up, checked below regardless.
            await this.logWarn(
              "Trip.com: navigation to verification link raised a warning, continuing",
              { error: navError?.message, candidate: i + 1 }
            );
          }

          await delay(3000);
          await this.takeScreenshot(`trip-post-verification-candidate-${i + 1}`);

          if (!page.url().includes("/login")) {
            verificationSucceeded = true;
            break;
          }

          await this.logWarn(
            `Trip.com: verification link candidate ${i + 1}/${verifyLinks.length} did not complete sign-in`,
            { url: page.url() }
          );
        }

        if (!verificationSucceeded) {
          const err = new Error(
            "Trip.com: still on the login page after trying all available verification links"
          );
          setFailedReasonCode(err, FAILED_REASON.TRIP_VERIFICATION_FAILED);
          throw err;
        }

        await this.logInfo("Trip.com: identity verification completed successfully", {
          url: page.url(),
        });
        return true;
      } finally {
        await otpStatusService.release(OtpPlatform.Trip, otpLockJobId);
        await this.logInfo(
          "Trip.com: released the shared email-verification lock"
        );
      }
    } catch (error) {
      await this.logError("Trip.com 2FA/identity verification failed", error);
      // Verification is mandatory for Trip.com (unlike Expedia's optional
      // 2FA) — re-throw so this propagates through executeScraping()'s
      // catch chain and fails the job, instead of silently continuing on
      // to scrapeData() against a still-unauthenticated page.
      if (!hasFailedReasonCode(error)) {
        setFailedReasonCode(error, FAILED_REASON.TRIP_VERIFICATION_FAILED);
      }
      throw error;
    }
  }

  /**
   * `propertyName` is the human-readable property name (e.g. "Aldhafra, a
   * Vignette Collection"), not a numeric ID — Trip.com's group dashboard is
   * searched by name.
   */
  async searchProperty(propertyName: string): Promise<boolean> {
    if (!this.page || !this.browser) throw new Error("Browser not initialized");
    const page = this.page;

    if (!propertyName || !propertyName.trim()) {
      await this.logWarn("Trip.com property search called without a property name");
      return false;
    }

    try {
      await this.logInfo("Searching for Trip.com property", { propertyName });

      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        throw new Error("Scraping was stopped during property search");
      }

      // Accounts that manage only one property skip the "Your Properties"
      // group table entirely and land straight on the property dashboard —
      // nothing to search for in that case. Still confirm the landed
      // property's displayed name actually matches the expected one before
      // trusting it (a login pointed at the wrong single-property account
      // would otherwise silently scrape/reveal VCC data for the wrong
      // hotel with no error).
      if (!page.url().includes(TRIP_GROUP_SELECTORS.groupUrlFragment)) {
        await this.logInfo(
          "Trip.com account landed directly on a property dashboard, skipping property search",
          { currentUrl: page.url() }
        );

        const displayedName = await page
          .waitForSelector(TRIP_SINGLE_PROPERTY_SELECTORS.hotelTitleLink, {
            visible: true,
            timeout: 10000,
          })
          .then(() =>
            page.$eval(
              TRIP_SINGLE_PROPERTY_SELECTORS.hotelTitleLink,
              (el) => el.textContent?.trim() || ""
            )
          )
          .catch(() => "");

        if (!displayedName) {
          await this.logWarn(
            "Trip.com: single-property account landed on a dashboard but could not read the displayed property name to confirm identity — proceeding anyway",
            { currentUrl: page.url() }
          );
          return true;
        }

        const MATCH_THRESHOLD = 0.34;
        const score = nameSimilarity(propertyName, displayedName);

        await this.logInfo(
          "Trip.com: single-property account — comparing displayed property name against expected",
          { expected: propertyName, displayed: displayedName, score }
        );

        if (score < MATCH_THRESHOLD) {
          await this.takeScreenshot("trip-single-property-name-mismatch");
          await this.logWarn(
            "Trip.com: single-property account's displayed property name does not match the expected property",
            { expected: propertyName, displayed: displayedName, score }
          );
          return false;
        }

        await this.logInfo(
          "Trip.com: confirmed single-property account matches the expected property",
          { displayed: displayedName, score }
        );
        return true;
      }

      await page.waitForSelector(TRIP_GROUP_SELECTORS.propertySearchInput, {
        visible: true,
      });

      const candidates = buildPropertySearchCandidates(propertyName);
      const MATCH_THRESHOLD = 0.34;

      for (const term of candidates) {
        await scrapingStateManager.waitWhilePaused();
        if (!scrapingStateManager.isRunning()) {
          throw new Error("Scraping was stopped during property search");
        }

        // Give the page a moment to fully settle before starting a new
        // search term — clearing/retyping immediately after the previous
        // term's results just rendered was racing the previous search's
        // debounce/filter, causing the next term (e.g. "Aldhafra" after
        // the full name failed) to sometimes match against stale results.
        await delay(1500);

        await dualLogInfo(`Trip.com: trying property search term "${term}"`);

        // This is a third-party (React-controlled) input — a plain
        // triple-click + Backspace unreliably leaves stale text behind, so
        // clear it via the native value setter + a real "input" event
        // (verified live against the actual page) before typing the term.
        await page.evaluate((selector) => {
          const input = document.querySelector(selector) as HTMLInputElement | null;
          if (!input) return;
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value"
          )?.set;
          nativeSetter?.call(input, "");
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }, TRIP_GROUP_SELECTORS.propertySearchInput);

        await page.click(TRIP_GROUP_SELECTORS.propertySearchInput);
        await typeWithRandomDelay(page, term);
        await page.keyboard.press("Enter");

        // The results table filters client-side with a short debounce.
        await delay(2000);

        const rows = await page.evaluate((rowSelector) => {
          const trs = Array.from(document.querySelectorAll(rowSelector));
          return trs.map((tr, index) => {
            const nameCell = tr.querySelector("td:first-child");
            if (!nameCell) return { index, name: "" };
            // When the "Display property address" toggle is on, the name
            // is wrapped in its own <div> alongside a sibling address
            // <span> — use just the <div> text. When the toggle is off,
            // the cell contains only the plain name text directly.
            const nameDiv = nameCell.querySelector("div");
            const name = (nameDiv ? nameDiv.textContent : nameCell.textContent) || "";
            return { index, name: name.trim() };
          });
        }, TRIP_GROUP_SELECTORS.propertyRow);

        if (rows.length === 0) {
          await dualLogInfo(`Trip.com: no properties matched search term "${term}"`);
          continue;
        }

        let best: { index: number; name: string; score: number } | null = null;
        for (const row of rows) {
          if (!row.name) continue;
          const score = nameSimilarity(propertyName, row.name);
          if (!best || score > best.score) {
            best = { ...row, score };
          }
        }

        if (!best || best.score < MATCH_THRESHOLD) {
          await dualLogInfo(
            `Trip.com: no confident match for search term "${term}"`,
            { bestCandidate: best?.name, bestScore: best?.score }
          );
          continue;
        }

        await this.logInfo("Trip.com: matched property in group list", {
          searchTerm: term,
          matchedName: best.name,
          score: best.score,
        });

        const clicked = await page.evaluate(
          (rowSelector, detailsSelector, rowIndex) => {
            const trs = Array.from(document.querySelectorAll(rowSelector));
            const tr = trs[rowIndex];
            const button = tr?.querySelector(detailsSelector) as HTMLElement | null;
            if (button) {
              button.click();
              return true;
            }
            return false;
          },
          TRIP_GROUP_SELECTORS.propertyRow,
          TRIP_GROUP_SELECTORS.detailsButtonInRow,
          best.index
        );

        if (!clicked) {
          await this.logWarn(
            "Trip.com: found a matching row but could not click its Details button"
          );
          continue;
        }

        await page
          .waitForFunction(
            (fragment) => !window.location.pathname.includes(fragment),
            { timeout: 15000 },
            TRIP_GROUP_SELECTORS.groupUrlFragment
          )
          .catch(() => null);

        await this.takeScreenshot("trip-property-selected");
        await this.logInfo("Trip.com: navigated into property dashboard", {
          url: page.url(),
        });
        return true;
      }

      await this.logWarn(
        "Trip.com: exhausted all search terms without a confident property match",
        { propertyName, triedTerms: candidates }
      );
      await this.takeScreenshot("trip-property-search-no-match");
      return false;
    } catch (error) {
      await this.logError("Trip.com property search failed", error);
      return false;
    }
  }

  /**
   * The actual DOM search/click for the "Allow Notifications" card, run
   * inside a single frame's context. Shared between the main frame and any
   * same-origin iframes since the card's markup could live in either
   * (`page.evaluate` only sees the main frame — it can't reach into
   * iframes at all — which is the leading theory for why the main-frame-only
   * version of this never actually removed the card on the server).
   */
  private static readonly findAndClickNotificationsCard = () => {
    const heading = Array.from(document.querySelectorAll("body *")).find(
      (el) => {
        const text = el.textContent?.trim() || "";
        return (
          el.children.length === 0 &&
          /allow notifications/i.test(text) &&
          text.length < 60
        );
      }
    );
    if (!heading) return false;

    // Walk up to find the floating card container (bounded size, not the full page/body).
    let container: Element | null = heading;
    for (let i = 0; i < 6 && container; i++) {
      const parent: Element | null = container.parentElement;
      if (!parent) break;
      container = parent;
      const rect = container.getBoundingClientRect();
      if (rect.width > 200 && rect.width < 700 && rect.height > 60) {
        break;
      }
    }
    if (!container) return false;

    const closeBtn = container.querySelector(
      '[aria-label*="close" i], [class*="close" i]'
    ) as HTMLElement | null;
    const allowBtn = Array.from(
      container.querySelectorAll("button, a, div, span")
    ).find((el) => /^allow$/i.test(el.textContent?.trim() || "")) as
      | HTMLElement
      | undefined;

    const target = closeBtn || allowBtn;
    if (target) {
      target.click();
      return true;
    }
    return false;
  };

  /**
   * Single check-and-dismiss attempt for Trip.com's page-level "Allow
   * Notifications" card (not a native browser permission prompt — it's
   * rendered by the page/an embedded widget, not by Chrome itself). Checks
   * every frame currently attached to the page (main frame + any
   * same-origin iframes), clicking the card's close (×) control if found,
   * else its "Allow" button (harmless either way — both just remove the
   * card). Returns whether it found (and clicked) anything anywhere; no-ops
   * silently (returns false) if the card isn't present in any frame.
   */
  private async dismissNotificationPermissionPopupIfPresent(): Promise<boolean> {
    if (!this.page) return false;

    let dismissedAny = false;
    for (const frame of this.page.frames()) {
      try {
        const dismissed = await frame.evaluate(
          TripScraper.findAndClickNotificationsCard
        );
        if (dismissed) dismissedAny = true;
      } catch {
        // Cross-origin/detached frames throw on evaluate — skip, non-fatal.
      }
    }

    if (dismissedAny) {
      await this.logInfo('Trip.com: dismissed "Allow Notifications" popup');
    }
    return dismissedAny;
  }

  /**
   * Navigates to the VCC (virtual card) settlement page and captures the
   * exact `queryVccOrder` request the page fires itself, automatically, on
   * load. This app signs every request with opaque anti-bot headers
   * (`spidertoken`, `w-payload-source`, etc.) computed by its own bundled
   * JS — there's no feasible way to regenerate them ourselves, so instead
   * we capture one real, live request (headers + body template, including
   * the account/property-specific `hotelId`) and later replay it with
   * different `beginCheckInDate`/`endCheckInDate` values per month chunk.
   *
   * Live-verified (2026-09-21): these tokens are NOT tied to the request
   * body — reusing the same captured headers across several different
   * date-range queries in the same page session all returned
   * `status: 200` / `resStatus.rcode: 200`.
   *
   * The capture hook is installed via `page.evaluateOnNewDocument` (not a
   * post-load `page.evaluate`) so it's guaranteed to exist before the
   * page's own bundle mounts and fires its default-range request.
   */
  private async navigateToVccAndCaptureTemplate(): Promise<{
    url: string;
    headers: Record<string, string>;
    bodyTemplate: Record<string, unknown>;
  } | null> {
    if (!this.page) throw new Error("Browser not initialized");
    const page = this.page;

    await page.evaluateOnNewDocument(() => {
      (window as any).__capturedVccRequest = null;
      const origFetch = window.fetch.bind(window);
      (window as any).fetch = (url: any, init?: any) => {
        if (
          !(window as any).__capturedVccRequest &&
          init?.method === "POST" &&
          String(url).includes("queryVccOrder")
        ) {
          (window as any).__capturedVccRequest = {
            url: String(url),
            headers: init.headers,
            body: init.body,
          };
        }
        return origFetch(url, init);
      };
    });

    await this.logInfo("Trip.com: navigating to VCC settlement page", {
      url: TRIP_VCC_URL,
    });
    await page.goto(TRIP_VCC_URL, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

    // Trip.com shows a page-level (non-native) "Allow Notifications" card on
    // top of this page for accounts/sessions that haven't dismissed it yet.
    // Live-observed (2026-09-21): while it's up, the settlement page's own
    // component underneath never mounts/fires its default queryVccOrder
    // request at all — the capture below then times out with nothing to
    // show. It can render at any point relative to `networkidle2` resolving,
    // so check for (and dismiss) it on every poll tick below, right
    // alongside checking for the capture itself, rather than just once
    // upfront.
    const captureTimeoutMs = 15000;
    const pollIntervalMs = 500;
    const captureStartedAt = Date.now();
    let captured: {
      url: string;
      headers: Record<string, string>;
      body: string;
    } | null = null;

    while (Date.now() - captureStartedAt < captureTimeoutMs) {
      captured = await page
        .evaluate(() => (window as any).__capturedVccRequest)
        .catch(() => null);
      if (captured) break;

      await this.dismissNotificationPermissionPopupIfPresent();
      await delay(pollIntervalMs);
    }

    if (!captured) {
      await this.takeScreenshot("trip-vcc-request-not-captured");
      await this.logWarn(
        "Trip.com: did not observe the VCC page's default queryVccOrder request — cannot query VCC orders"
      );
      return null;
    }

    let bodyTemplate: Record<string, unknown>;
    try {
      bodyTemplate = JSON.parse(captured.body);
    } catch {
      await this.logWarn(
        "Trip.com: captured VCC request body was not valid JSON"
      );
      return null;
    }

    await this.logInfo("Trip.com: captured VCC request template", {
      hotelId: (bodyTemplate as any)?.hotelId,
    });

    return { url: captured.url, headers: captured.headers, bodyTemplate };
  }

  /** Replays the captured VCC request template with a different date range. */
  private async queryVccOrdersForChunk(
    template: {
      url: string;
      headers: Record<string, string>;
      bodyTemplate: Record<string, unknown>;
    },
    chunk: { beginCheckInDate: string; endCheckInDate: string }
  ): Promise<unknown[]> {
    if (!this.page) throw new Error("Browser not initialized");

    const body = {
      ...template.bodyTemplate,
      beginCheckInDate: chunk.beginCheckInDate,
      endCheckInDate: chunk.endCheckInDate,
    };

    const result = await this.page.evaluate(
      async (url: string, headers: Record<string, string>, bodyJson: string) => {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: bodyJson,
          credentials: "same-origin",
        });
        const json = await res.json().catch(() => null);
        return { status: res.status, json };
      },
      template.url,
      template.headers,
      JSON.stringify(body)
    );

    const rcode = (result.json as any)?.resStatus?.rcode;
    if (result.status !== 200 || rcode !== 200) {
      await this.logWarn(
        "Trip.com: VCC order query returned a non-success result",
        { chunk, status: result.status, rcode }
      );
      return [];
    }

    return ((result.json as any)?.data as unknown[]) ?? [];
  }

  /**
   * Submits the VCC password modal on the currently-loaded `vcc-details`
   * page and races the three possible outcomes observed live (2026-09-21):
   *  - `"error"`: wrong password — inline "Wrong password. Double-check
   *    and try again." text renders in the same modal (no navigation).
   *  - `"otp_required"`: this browser session hasn't completed the
   *    one-time `scene=VIEW_VCC_CARD_DETAIL` email-code check yet — the
   *    page navigates to a dedicated `/login/verify?...&scene=...` page.
   *  - `"revealed"`: password accepted AND the session was already
   *    verified — the "Card details" panel fills in with real values in
   *    place, no navigation.
   * If the unlock button isn't present at all (e.g. this tab is being
   * reused and the page was left in an already-revealed state), skips
   * straight to checking whether it's already revealed.
   */
  private async submitVccPasswordAndWaitForOutcome(
    tab: Page,
    tripVccPassword: string
  ): Promise<"error" | "otp_required" | "revealed" | "timeout"> {
    const unlockVisible = await tab
      .waitForSelector(TRIP_VCC_DETAILS_SELECTORS.unlockButton, {
        visible: true,
        timeout: 8000,
      })
      .then(() => true)
      .catch(() => false);

    if (!unlockVisible) {
      const alreadyRevealed = await tab
        .evaluate(
          () => document.body.textContent?.includes("Card number:") ?? false
        )
        .catch(() => false);
      return alreadyRevealed ? "revealed" : "timeout";
    }

    await tab.click(TRIP_VCC_DETAILS_SELECTORS.unlockButton);

    await tab.waitForSelector(TRIP_VCC_DETAILS_SELECTORS.passwordInput, {
      visible: true,
      timeout: 10000,
    });
    await tab.click(TRIP_VCC_DETAILS_SELECTORS.passwordInput);
    await typeWithRandomDelay(tab, tripVccPassword);
    await tab.click(TRIP_VCC_DETAILS_SELECTORS.confirmButton);

    const outcome = await firstNonNull<"error" | "otp_required" | "revealed">(
      [
        tab
          .waitForSelector(TRIP_VCC_DETAILS_SELECTORS.errorText, {
            visible: true,
            timeout: 15000,
          })
          .then(() => "error" as const)
          .catch(() => null),
        tab
          .waitForFunction(
            (fragment) => window.location.href.includes(fragment),
            { timeout: 15000 },
            TRIP_VCC_OTP_SELECTORS.urlFragment
          )
          .then(() => "otp_required" as const)
          .catch(() => null),
        tab
          .waitForFunction(
            () =>
              document.body.textContent?.includes("Card number:") ?? false,
            { timeout: 15000 }
          )
          .then(() => "revealed" as const)
          .catch(() => null),
      ]
    );

    return outcome ?? "timeout";
  }

  /**
   * Solves the one-time-per-session `scene=VIEW_VCC_CARD_DETAIL` email
   * OTP challenge on the current page. Mirrors the sign-in email-link
   * verification's polling/retry structure (`handle2FA`), but this scene
   * emails a 6-digit code (subject "Your Trip eBooking verification code")
   * instead of a magic link, typed into 6 separate `aria-label`ed boxes.
   * On success, the page navigates away from the verify URL (back to the
   * still-LOCKED `vcc-details` page — the caller must resubmit the
   * password once more to actually reveal the card).
   */
  private async solveVccOtpChallenge(tab: Page): Promise<void> {
    await this.takeScreenshot("trip-vcc-otp-required");
    await this.logInfo(
      "Trip.com: VCC card-details verification (one-time per browser session) requires a 6-digit email code"
    );

    // This screen also shows a masked destination email (verified live
    // 2026-09-21: "ar***t@hyattfinance.com" — note this convention keeps
    // the `@` visible, unlike the sign-in verification screen's). Parse it
    // into a regex so the Gmail lookup below can prefer a candidate whose
    // real `To` header actually matches, instead of blindly trusting
    // "newest email matching from+subject" when multiple properties could
    // be verifying around the same time.
    const otpPageText = await tab
      .evaluate(() => document.body.textContent || "")
      .catch(() => "");
    const expectedVccRecipientPattern = parseMaskedEmailPattern(otpPageText);

    if (expectedVccRecipientPattern) {
      await this.logInfo(
        "Trip.com: parsed expected recipient pattern from the masked email shown on the VCC OTP screen",
        { pattern: expectedVccRecipientPattern.source }
      );
    } else {
      await this.logWarn(
        "Trip.com: could not find/parse a masked email on the VCC OTP screen — proceeding without a recipient cross-check"
      );
    }

    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      const err = new Error(
        "Scraping was stopped during VCC card-details verification"
      );
      setFailedReasonCode(err, FAILED_REASON.SCRAPING_STOPPED);
      throw err;
    }

    // Same shared-inbox constraint as the sign-in verification flow (see
    // handle2FA) — only one Trip job may be actively polling Gmail for a
    // verification code at a time. Occupy the shared lock before waiting;
    // always release it in `finally` below regardless of outcome.
    const otpLockJobId = this.jobId || `standalone-${Date.now()}`;
    const otpLockAcquired = await otpStatusService.waitAndAcquire(
      OtpPlatform.Trip,
      otpLockJobId,
      {
        onWaiting: async (elapsedMs) => {
          await this.logInfo(
            `Trip.com: waiting for the shared email-verification lock (another job is currently using it) — ${Math.round(
              elapsedMs / 1000
            )}s elapsed`
          );
        },
      }
    );

    if (!otpLockAcquired) {
      throw createTripOtpLockTimeoutError();
    }

    await this.logInfo(
      "Trip.com: acquired the shared email-verification lock"
    );

    try {
      const sinceMs = Date.now() - 30_000;
      const initialWaitMs = 60_000;
      await this.logInfo(
        `Trip.com: waiting ${Math.round(
          initialWaitMs / 1000
        )}s for the VCC verification code email to arrive`
      );
      await delay(initialWaitMs);

      const maxPollAttempts = 3;
      const pollDelayMs = 20_000;
      let codes: string[] = [];

      for (let attempt = 1; attempt <= maxPollAttempts; attempt++) {
        await scrapingStateManager.waitWhilePaused();
        if (!scrapingStateManager.isRunning()) {
          const err = new Error(
            "Scraping was stopped during VCC card-details verification"
          );
          setFailedReasonCode(err, FAILED_REASON.SCRAPING_STOPPED);
          throw err;
        }

        await this.logInfo(
          `Trip.com: checking email for the VCC verification code (attempt ${attempt}/${maxPollAttempts})`
        );
        codes = await getTripVccVerificationCodes(
          sinceMs,
          3,
          expectedVccRecipientPattern ?? undefined
        );
        if (codes.length > 0) break;
        if (attempt < maxPollAttempts) await delay(pollDelayMs);
      }

      if (codes.length === 0) {
        await this.takeScreenshot("trip-vcc-otp-email-not-found");
        throw createTripVccOtpCodeNotFoundError();
      }

      await this.logInfo(
        `Trip.com: found ${codes.length} VCC verification code candidate(s), will try each in order`
      );

      let solved = false;

      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code.length !== 6) continue;

        await this.logInfo(
          `Trip.com: trying VCC verification code candidate ${i + 1}/${codes.length}`
        );

        for (let digit = 0; digit < 6; digit++) {
          await tab.click(TRIP_VCC_OTP_SELECTORS.otpInput(digit + 1));
          await typeWithRandomDelay(tab, code[digit]);
        }

        // Plain <button> with no stable he-click/id attribute observed on
        // this specific page — locate it by its visible text instead.
        await tab.evaluate(() => {
          const confirmBtn = Array.from(
            document.querySelectorAll("button")
          ).find(
            (b) =>
              b.textContent?.trim() === "Confirm" &&
              !(b as HTMLButtonElement).disabled
          ) as HTMLButtonElement | undefined;
          confirmBtn?.click();
        });

        await delay(2000);

        if (!tab.url().includes(TRIP_VCC_OTP_SELECTORS.urlFragment)) {
          solved = true;
          break;
        }

        await this.logWarn(
          `Trip.com: VCC verification code candidate ${i + 1}/${codes.length} did not complete verification`
        );

        // Clear the boxes before trying the next candidate.
        for (let digit = 0; digit < 6; digit++) {
          await tab
            .evaluate((sel) => {
              const input = document.querySelector(
                sel
              ) as HTMLInputElement | null;
              if (!input) return;
              const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype,
                "value"
              )?.set;
              nativeSetter?.call(input, "");
              input.dispatchEvent(new Event("input", { bubbles: true }));
            }, TRIP_VCC_OTP_SELECTORS.otpInput(digit + 1))
            .catch(() => {});
        }
      }

      if (!solved) {
        await this.takeScreenshot("trip-vcc-otp-all-candidates-failed");
        throw createTripVccOtpFailedError();
      }

      await this.logInfo(
        "Trip.com: VCC card-details verification completed successfully",
        { url: tab.url() }
      );
      // Let the redirect back to the (still-locked) vcc-details page settle.
      await delay(1500);
    } finally {
      await otpStatusService.release(OtpPlatform.Trip, otpLockJobId);
      await this.logInfo(
        "Trip.com: released the shared email-verification lock"
      );
    }
  }

  /**
   * Extracts every label/value pair from the revealed "Card details" (and,
   * incidentally, "Reservation details") panels — both use the same
   * `.index_infoGroup` container with `.index_infoLabel` + sibling
   * `.index_infoValue` spans (verified live 2026-09-21). Reads only text
   * nodes from the value span to exclude the "copy" icon button rendered
   * inside the Card number value.
   */
  private async extractRevealedVccCardDetails(
    tab: Page
  ): Promise<Record<string, string>> {
    return tab.evaluate(
      (groupSel, labelSel, valueSel) => {
        const result: Record<string, string> = {};
        const groups = Array.from(document.querySelectorAll(groupSel));
        for (const group of groups) {
          const labels = Array.from(group.querySelectorAll(labelSel));
          for (const labelEl of labels) {
            const rawLabel = labelEl.textContent?.trim() ?? "";
            if (!rawLabel) continue;
            const key = rawLabel.replace(/:\s*$/, "");
            const valueEl = labelEl.nextElementSibling;
            if (!valueEl || !valueEl.matches(valueSel)) continue;
            let value = "";
            valueEl.childNodes.forEach((node) => {
              if (node.nodeType === Node.TEXT_NODE) {
                value += node.textContent || "";
              }
            });
            result[key] = value.trim();
          }
        }
        return result;
      },
      TRIP_VCC_DETAILS_SELECTORS.revealedInfoGroup,
      TRIP_VCC_DETAILS_SELECTORS.revealedInfoLabel,
      TRIP_VCC_DETAILS_SELECTORS.revealedInfoValue
    );
  }

  /**
   * For each qualifying VCC order, opens `vcc-details` for that specific
   * `hotelId`/`orderId` in a single dedicated tab (reused/re-navigated
   * across orders rather than one tab per order), gated on the property
   * having a `tripVccPassword` configured — without it there's no way to
   * reveal the card, so this step is skipped entirely by the caller.
   *
   * Live-verified (2026-09-21) end-to-end against real orders, including
   * the once-per-session `scene=VIEW_VCC_CARD_DETAIL` email-OTP challenge:
   * on the FIRST order of a session, submitting the (correct) password
   * navigates to a 6-digit-code verify page instead of revealing the card;
   * solving that OTP redirects back to the still-LOCKED details page, so
   * the password must be resubmitted once more — which then reveals the
   * card directly with no further OTP for the rest of the session/every
   * subsequent order. A wrong password shows an inline error ("Wrong
   * password. Double-check and try again.") without navigating; since this
   * password is per-property (not per-order), that fails the whole job
   * immediately instead of retrying per-order.
   */
  private async captureVccOrderCardDetails(
    vccOrders: unknown[],
    tripVccPassword: string
  ): Promise<Array<Record<string, unknown>>> {
    if (!this.browser) throw new Error("Browser not initialized");

    const detailsTab = await this.browser.newPage();
    const results: Array<Record<string, unknown>> = [];

    try {
      for (const order of vccOrders) {
        const hotelId = (order as any)?.hotelId;
        const orderId = (order as any)?.orderId;
        if (hotelId == null || orderId == null) {
          await this.logWarn(
            "Trip.com: skipping VCC order missing hotelId/orderId",
            { order }
          );
          continue;
        }

        const detailsUrl = `${TRIP_VCC_DETAILS_URL_BASE}?hotelId=${hotelId}&orderId=${orderId}&source=Finance`;

        await this.logInfo("Trip.com: opening VCC order details tab", {
          hotelId,
          orderId,
          url: detailsUrl,
        });

        await detailsTab.goto(detailsUrl, {
          waitUntil: "networkidle2",
          timeout: 30000,
        });

        let cardDetails: Record<string, string> | null = null;

        // At most 2 rounds: round 1 may resolve straight to "revealed", or
        // may divert into the once-per-session OTP challenge, in which
        // case round 2 resubmits the (already-known-correct) password to
        // actually reveal the card.
        for (let attempt = 1; attempt <= 2; attempt++) {
          const outcome = await this.submitVccPasswordAndWaitForOutcome(
            detailsTab,
            tripVccPassword
          );

          if (outcome === "error") {
            await this.takeScreenshot("trip-vcc-password-wrong");
            await this.logError(
              "Trip.com: VCC password rejected on order details page",
              { hotelId, orderId }
            );
            throw createTripVccPasswordWrongError();
          }

          if (outcome === "revealed") {
            cardDetails = await this.extractRevealedVccCardDetails(
              detailsTab
            );
            await this.logInfo(
              "Trip.com: VCC card details revealed and extracted",
              { hotelId, orderId, fields: Object.keys(cardDetails) }
            );
            break;
          }

          if (outcome === "otp_required") {
            if (attempt === 2) {
              // Solved once already this session — seeing it again is an
              // unexpected UI state, not the normal first-time flow.
              await this.takeScreenshot("trip-vcc-otp-unexpected-repeat");
              throw createTripVccOtpFailedError();
            }
            await this.solveVccOtpChallenge(detailsTab);
            continue; // loop around to resubmit the password
          }

          // "timeout" — none of the 3 expected outcomes happened in time.
          await this.takeScreenshot("trip-vcc-unlock-timeout");
          await this.logError(
            "Trip.com: VCC unlock did not resolve to error/otp/revealed in time",
            { hotelId, orderId, currentUrl: detailsTab.url() }
          );
          throw createTripVccOtpFailedError();
        }

        results.push({
          hotelId,
          orderId,
          url: detailsUrl,
          cardDetails: cardDetails ?? undefined,
        });

        await delay(500);
      }
    } finally {
      await detailsTab.close().catch(() => {});
    }

    return results;
  }

  /**
   * Persists one `queryVccOrder` result (plus its revealed card details, if
   * any) as a `job_items` row, following the same
   * `jobService.createJobItem` / `reservationExists` pattern used by the
   * Expedia scraper (`scrape-data.ts`). Every queried order gets a row
   * regardless of whether its card was actually unlocked (per confirmed
   * field-mapping decisions, 2026-09-21) — Trip.com's VCC data simply
   * doesn't expose several fields Expedia's schema was originally modeled
   * on (`confirmation_number`, `room_type`, `booked_date`,
   * `reservation_status`, and payment-side `cancellation_fee`/
   * `total_payout`), so those get fixed placeholder values instead of
   * being scraped:
   *  - confirmation_number: "" (no distinct field from orderId)
   *  - room_type: "N/A" (not exposed at all)
   *  - booked_date: same as check_in_date (no "date booked" field)
   *  - reservation_status: static "VCC Active"
   *  - cancellation_fee / total_payout: 0 (not exposed)
   */
  private async saveVccOrderAsJobItem(
    order: unknown,
    cardDetails: Record<string, string> | undefined,
    jobId: string,
    propertyIdForDb: string
  ): Promise<void> {
    const o = order as Record<string, unknown>;
    const orderId = o?.orderId;
    if (orderId == null) return;

    const reservationId = String(orderId);

    try {
      if (await jobService.reservationExists(jobId, reservationId)) {
        await this.logInfo(
          "Trip.com: skipping duplicate VCC order job_item (already saved)",
          { jobId, reservationId }
        );
        return;
      }

      const currency =
        (o?.currency as string | undefined) ??
        (o?.cardCurrency as string | undefined) ??
        undefined;
      const checkInDate = parseVccOrderDate(o?.checkInDate as string);

      const hasCardInfo = !!cardDetails?.["Card number"];
      const cardInfo = hasCardInfo
        ? {
            card_number: cardDetails!["Card number"] || "",
            expiry_date: cardDetails!["Expiration date"] || "",
            cvv: cardDetails!["CVV"] || undefined,
            card_holder_name: cardDetails!["Cardholder"] || undefined,
          }
        : undefined;

      const jobItemData: CreateJobItemData = {
        job_id: jobId,
        property_id: propertyIdForDb,
        guest_name: (o?.guestName as string) || "Unknown Guest",
        reservation_id: reservationId,
        confirmation_number: "",
        check_in_date: checkInDate,
        check_out_date: parseVccOrderDate(o?.checkOutDate as string),
        room_type: "N/A",
        booking_amount:
          typeof o?.charge === "number" ? (o.charge as number) : 0,
        booked_date: checkInDate,
        has_card_info: hasCardInfo,
        card_info: cardInfo,
        has_payment_info: true,
        payment_info: {
          total_guest_payment:
            typeof o?.charge === "number" ? (o.charge as number) : 0,
          cancellation_fee: 0,
          total_payout: 0,
          amount_to_charge_or_refund:
            typeof o?.balance === "number" ? (o.balance as number) : 0,
          amount_to_charge_or_refund_currency: currency,
        },
        reservation_status: "VCC Active",
      };

      await jobService.createJobItem(jobItemData);
      await this.logInfo("Trip.com: saved VCC order as job_item", {
        jobId,
        reservationId,
        hasCardInfo,
      });
    } catch (error: any) {
      // Mirrors scrape-data.ts's Expedia behavior: a DB save failure for
      // one order shouldn't abort the rest of the job.
      await this.logError(
        `Trip.com: failed to save VCC order ${reservationId} as job_item`,
        error?.message
      );
    }
  }

  async scrapeData(params: ScrapingJobParams): Promise<ScrapingResult> {
    if (!this.page || !this.browser) throw new Error("Browser not initialized");

    try {
      await this.logInfo("Starting Trip.com data scraping", {
        propertyId: params.propertyId,
      });

      if (params.propertyId) {
        const found = await this.searchProperty(params.propertyId);
        if (!found) {
          return {
            success: false,
            error: `Trip.com: could not find/select property "${params.propertyId}" in the group dashboard`,
          };
        }
      } else {
        await this.logWarn(
          "Trip.com: no propertyId provided, skipping property search"
        );
      }

      await this.takeScreenshot("trip-scraping-property-dashboard");

      let vccOrders: unknown[] = [];
      let vccDateChunks: Array<{
        beginCheckInDate: string;
        endCheckInDate: string;
      }> = [];
      let vccCardDetails: Array<Record<string, unknown>> = [];

      if (params.endDate) {
        vccDateChunks = computeVccDateChunks(params.endDate, 180);
        const template = await this.navigateToVccAndCaptureTemplate();

        if (template) {
          await this.logInfo(
            "Trip.com: querying VCC orders across date chunks",
            { chunkCount: vccDateChunks.length, chunks: vccDateChunks }
          );

          for (let i = 0; i < vccDateChunks.length; i++) {
            const chunk = vccDateChunks[i];
            await scrapingStateManager.waitWhilePaused();
            if (!scrapingStateManager.isRunning()) {
              throw new Error("Scraping was stopped during VCC order query");
            }

            await this.logInfo(
              `Trip.com: querying VCC orders for chunk ${i + 1}/${vccDateChunks.length}`,
              { beginCheckInDate: chunk.beginCheckInDate, endCheckInDate: chunk.endCheckInDate }
            );

            const orders = await this.queryVccOrdersForChunk(template, chunk);
            vccOrders.push(...orders);

            await this.logInfo(
              `Trip.com: chunk ${i + 1}/${vccDateChunks.length} returned ${orders.length} order(s)`,
              { beginCheckInDate: chunk.beginCheckInDate, endCheckInDate: chunk.endCheckInDate, orderCount: orders.length }
            );

            // Human-like randomized buffer between requests (instead of a
            // fixed delay) so we don't hammer the endpoint at an exact,
            // identical interval across 6+ chunks — an easy automation tell.
            await randomDelay(2000, 4000);
          }

          await this.logInfo("Trip.com: VCC order query complete", {
            totalOrders: vccOrders.length,
          });

          // Sum the `balance` field across every order from every date
          // chunk. If the total isn't greater than the threshold (default
          // 100, in whatever currency the orders themselves report),
          // there's nothing worth processing — fail the job fast with that
          // exact reason instead of continuing.
          const currency =
            (vccOrders[0] as any)?.currency ??
            (vccOrders[0] as any)?.cardCurrency ??
            "UNKNOWN";
          const totalBalance = vccOrders.reduce((sum: number, order) => {
            const balance = (order as any)?.balance;
            return sum + (typeof balance === "number" ? balance : 0);
          }, 0);

          await this.logInfo("Trip.com: total VCC card balance computed", {
            totalBalance,
            currency,
            orderCount: vccOrders.length,
          });

          const BALANCE_THRESHOLD = 100;
          if (totalBalance <= BALANCE_THRESHOLD) {
            throw createTripVccBalanceTooLowError(
              totalBalance,
              currency,
              BALANCE_THRESHOLD
            );
          }

          // Balance is above the threshold — there's something worth
          // collecting card info for. Only attempt it if the property has
          // a VCC reveal password configured; without one there's no way
          // to unlock the card details anyway.
          if (params.tripVccPassword) {
            await this.logInfo(
              "Trip.com: balance above threshold, opening VCC order details",
              { orderCount: vccOrders.length }
            );
            vccCardDetails = await this.captureVccOrderCardDetails(
              vccOrders,
              params.tripVccPassword
            );
          } else {
            await this.logWarn(
              "Trip.com: balance above threshold but no tripVccPassword configured — skipping card detail capture"
            );
          }

          // Persist every queried order as a job_item, regardless of
          // whether its card was actually unlocked above (confirmed
          // 2026-09-21) — only possible when running as a real job
          // (jobId + propertyIdForDb come from the DB-backed job/property
          // records); the standalone test-run endpoint doesn't set these,
          // so this is skipped there exactly like scrape-data.ts does for
          // Expedia.
          if (params.jobId && this.propertyIdForDb) {
            const cardDetailsByOrderId = new Map<
              string,
              Record<string, string> | undefined
            >();
            for (const captured of vccCardDetails) {
              const capturedOrderId = (captured as any)?.orderId;
              if (capturedOrderId != null) {
                cardDetailsByOrderId.set(
                  String(capturedOrderId),
                  (captured as any)?.cardDetails
                );
              }
            }

            for (const order of vccOrders) {
              await scrapingStateManager.waitWhilePaused();
              if (!scrapingStateManager.isRunning()) {
                throw new Error(
                  "Scraping was stopped while saving VCC orders"
                );
              }

              const orderId = (order as any)?.orderId;
              await this.saveVccOrderAsJobItem(
                order,
                orderId != null
                  ? cardDetailsByOrderId.get(String(orderId))
                  : undefined,
                params.jobId,
                this.propertyIdForDb
              );
            }
          } else {
            await this.logWarn(
              "Trip.com: no jobId/propertyIdForDb available — skipping job_item database storage (expected for standalone test runs)"
            );
          }
        }
      } else {
        await this.logWarn(
          "Trip.com: no endDate provided, skipping VCC order query"
        );
      }

      // TODO: additional data extraction (reservations / rates & availability /
      // reviews, etc.) still needs to be decided and implemented.

      return {
        success: true,
        data: {
          platform: "trip",
          timestamp: new Date().toISOString(),
          jobId: params.jobId,
          propertyId: params.propertyId,
          currentUrl: this.page.url(),
          vccDateRange: vccDateChunks,
          vccOrders,
          vccCardDetails,
        },
        screenshots: ["trip-scraping-property-dashboard"],
      };
    } catch (error) {
      await this.logError("Trip.com data scraping failed", error);

      // Errors we've deliberately tagged with a failedReasonCode (e.g. the
      // VCC balance-too-low check above) need to propagate all the way out
      // of executeScraping() so *its* catch block can call
      // jobService.updateJobStatusWithReason() with that specific reason
      // text — returning `{ success: false }` here instead would silently
      // swallow it and the job would end up "Failed" with no reason saved.
      if (hasFailedReasonCode(error)) {
        throw error;
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : "Trip.com scraping failed",
      };
    }
  }

  async cleanup(): Promise<void> {
    try {
      if (this.browser) {
        await this.browser.close();
        await this.logInfo("Trip.com browser closed successfully");
      }
    } catch (error) {
      await this.logError("Trip.com cleanup failed", error);
    }
  }
}
