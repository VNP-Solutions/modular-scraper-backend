import { Types } from "mongoose";
import fetch from "node-fetch";
import puppeteer, { Browser, Page } from "puppeteer";
import readline from "readline";
import {
  BookingErrorType,
  BookingScrapingPhase,
  getBookingErrorDescription,
  PlatformsType,
  shouldRetryBookingError,
} from "../common/booking-error-types.js";
import { applyBookingAntiDetection, type BookingBrowserProfile } from "../common/booking-anti-detection.js";
import {
  BOOKING_LOGIN_EXCLUDE_URLS,
  BOOKING_LOGIN_SUCCESS_URLS,
  BOOKING_SELECTORS,
  BOOKING_SIGN_IN_ERROR_SELECTORS,
  CAPTCHA_PATTERNS,
  matchesBookingSignInTryAgainLater,
  matchesBookingTechnicalDifficulties,
  PASSWORD_MISMATCH_PATTERNS,
  TWO_FA_PATTERNS,
  TWO_FA_TEXT_PATTERNS,
} from "../common/booking-selectors.js";
import { delay } from "../common/delay.js";
import { simulateHumanMouseMove } from "../common/human-browser-helper.js";
import { emailNotifier } from "../common/email-notifier.js";
import { decryptPassword } from "../common/encription.js";
import {
  BOOKING_SIGN_IN_TRY_AGAIN_LATER_MESSAGE,
  BOOKING_TECHNICAL_DIFFICULTIES_MESSAGE,
  createBookingInvalidCredentialsError,
  FAILED_REASON,
  hasFailedReasonCode,
  hasNoManual2FASolvePossible,
  setFailedReasonCode,
} from "../common/failed-reason.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { SelectorUtils } from "../common/selector-utils.js";
import { timeoutManager } from "../common/timeout-manager.js";
import { Property } from "../models/property.model.js";
import handleBookingOtpVerification from "../otp-verification/booking-otp-verification.js";
import {
  CaptchaService,
  CaptchaSolveResult,
} from "../services/captcha-service.js";
import { browserlessSessionService } from "../services/browserless-session.service.js";
import { cookieStorageService } from "../services/cookie-storage.service.js";
import { localChromeSessionService } from "../services/local-chrome-session.service.js";
import { propertyCredentialsService } from "../services/job-credentials.service.js";
import { phoneNumberSlotService } from "../services/phone-number-slot.service.js";
import {
  BaseScraper,
  CaptchaHandlerOptions,
  LoginCredentials,
  TwoFactorAuthOptions,
} from "./base-scraper.js";

export enum ScraperContext {
  JOB = "job",
  TRUST_VERIFICATION = "trust-verification",
}
export class BookingScraper extends BaseScraper {
  private browserlessToken: string;
  private sessionUrl?: string;
  protected currentPropertyName?: string;
  private context?: ScraperContext;
  private captchaService: CaptchaService;
  private sessionParams?: { ses: string; lang: string }; // Store session and language parameters
  /** During shared group login, copy screenshot_urls to other property jobs in the group. */
  private bookingGroupScreenshotMirrorJobIds: string[] | null = null;

  /** Shared fingerprint profile — reused across tabs in one scrape session. */
  private browserProfile?: BookingBrowserProfile;

  /**
   * Consecutive trust-unavailable card pages (legacy flow). Resets on successful card or non-trust outcome.
   * Cleared at the start of each scrapeData / traverse run so group steps do not share a streak.
   */
  private consecutiveGuestCardTrustUnavailable = 0;

  /**
   * When true, trust-unavailable streak is not applied (job already had job items in DB at run start).
   */
  private skipTrustUnavailableStreakForJobRun = false;

  /** First VCC card-details open in legacy list flow (fail job if no card on first try). */
  private vccFirstCardAttemptCompleted = false;

  /** True when connected to a persisted Browserless session (disconnect instead of close on cleanup). */
  private usingPersistentBrowserlessSession = false;

  /** True when using system Chrome + userDataDir profile (LOCAL_BROWSER=true). */
  private usingLocalChromeProfile = false;

  constructor(context?: ScraperContext) {
    super("booking", "https://admin.booking.com");
    this.browserlessToken =
      process.env.BROWSERLESS_TOKEN ||
      "2SXlnLjeZpwR2tV6ab1698bfe680a3959c2c681f06939ee3b";

    this.context = context;

    // Initialize captcha service with configuration
    this.captchaService = new CaptchaService({
      openaiApiKey: process.env.OPENAI_API_KEY,
      maxRetries: parseInt(process.env.CAPTCHA_MAX_RETRIES || "3"),
      timeout: parseInt(process.env.CAPTCHA_TIMEOUT || "120000"),
      enableOpenAIVision: process.env.ENABLE_OPENAI_VISION !== "false",
      enableBasicAuto: process.env.ENABLE_BASIC_AUTO !== "false",
      jobId: this.jobId,
    });
  }

  protected override getScreenshotMirrorJobIds(): string[] | undefined {
    return this.bookingGroupScreenshotMirrorJobIds ?? undefined;
  }

  public setBrowserData(page: Page, browser: Browser): void {
    this.page = page;
    this.browser = browser;
  }

  /**
   * Bind a real Mongo job id for OTP phone lock / `phone_number_slots`, and captcha screenshots.
   * Used when the scraper is not started via {@link executeScraping} (e.g. trust verification on the main thread).
   */
  public setScraperJobId(jobId: string | undefined): void {
    this.jobId = jobId;
    if (jobId) {
      this.captchaService.setJobId(jobId);
    }
  }

  public async hasValidCookies(): Promise<boolean> {
    if (!this.propertyIdForDb) {
      return false;
    }
    return await cookieStorageService.hasValidCookies(
      this.propertyIdForDb,
      PlatformsType.BOOKING
    );
  }

  private async resolveBookingLoginEmail(
    jobId?: string,
    loginEmailOverride?: string
  ): Promise<string | null> {
    if (loginEmailOverride?.trim()) {
      return loginEmailOverride.trim();
    }

    if (jobId) {
      try {
        const latest =
          await propertyCredentialsService.getBookingCredentialsFromJob(jobId);
        if (latest?.bookingUsername) {
          return latest.bookingUsername.trim();
        }
      } catch (error) {
        await this.logWarn(
          `Could not resolve Booking email from job ${jobId}`,
          error
        );
      }
    }

    if (this.credentials?.email) {
      return this.credentials.email.trim();
    }

    return null;
  }

  async setupBrowser(
    jobId?: string,
    loginEmail?: string
  ): Promise<{ browser: Browser; page: Page }> {
    try {
      // Check environment - use local browser for local/development
      const environment = process.env.ENVIRONMENT || "browserless";
      if (environment === "local" || environment === "development") {
        await this.logInfo(
          "Environment set to local/development, using local browser"
        );
        return await this.setupLocalBrowser(jobId, loginEmail);
      }

      await this.logInfo(
        "Setting up Booking.com browser with Browserless session"
      );

      // Get timeout configuration
      const loadingTimeout = jobId
        ? await timeoutManager.getLoadingTimeout(jobId)
        : 120000;
      const selectorTimeout = jobId
        ? await timeoutManager.getSelectorTimeout(jobId)
        : 30000;

      const resolvedLoginEmail = await this.resolveBookingLoginEmail(
        jobId,
        loginEmail
      );
      let session:
        | Awaited<
            ReturnType<
              typeof browserlessSessionService.getOrCreateSessionForEmail
            >
          >
        | null = null;

      if (resolvedLoginEmail) {
        await this.logInfo(
          `Resolving Browserless session for Booking account ${resolvedLoginEmail}`
        );
        try {
          session = await browserlessSessionService.getOrCreateSessionForEmail(
            resolvedLoginEmail,
            PlatformsType.BOOKING
          );
          this.usingPersistentBrowserlessSession = true;
        } catch (sessionError) {
          await this.logError(
            "Failed to get or create persisted Browserless session",
            sessionError
          );
        }
      } else {
        await this.logWarn(
          "No Booking login email available; creating anonymous Browserless session"
        );
      }

      if (!session) {
        const fallbackSession = await this.createBrowserlessSession();
        if (!fallbackSession?.connect) {
          await this.logInfo(
            "Failed to create Browserless session, falling back to local browser"
          );
          return await this.setupLocalBrowser(jobId, loginEmail);
        }
        session = {
          session: fallbackSession,
          isNew: true,
          reused: false,
        };
        this.usingPersistentBrowserlessSession = false;
      }

      await this.logInfo(
        session.reused
          ? "Reusing persisted Browserless session"
          : "Using new Browserless session",
        {
          sessionId: session.session.id,
          loginEmail: resolvedLoginEmail ?? "unknown",
        }
      );

      let browser: Browser;
      try {
        browser = await browserlessSessionService.connectToSession(
          session.session.connect
        );
      } catch (connectError) {
        if (resolvedLoginEmail && session.reused) {
          await this.logWarn(
            "Failed to connect to saved Browserless session; creating a fresh one",
            connectError
          );
          await browserlessSessionService.invalidateSessionForEmail(
            resolvedLoginEmail,
            session.session,
            PlatformsType.BOOKING
          );
          session = await browserlessSessionService.getOrCreateSessionForEmail(
            resolvedLoginEmail,
            PlatformsType.BOOKING
          );
          this.usingPersistentBrowserlessSession = true;
          browser = await browserlessSessionService.connectToSession(
            session.session.connect
          );
        } else {
          throw connectError;
        }
      }

      const page = await this.prepareBrowserlessPage(browser, session.reused);
      await this.logInfo("Connected to Browserless session successfully");

      // Apply anti-detection before any navigation so evaluateOnNewDocument fires
      await this.applyAntiDetection(page);

      await this.activatePageForAutomation(page);

      // Viewport is set by applyAntiDetection (includes deviceScaleFactor)
      await page.setDefaultNavigationTimeout(loadingTimeout);
      await page.setDefaultTimeout(selectorTimeout);

      await this.generateLiveUrl(page);

      if (browserlessSessionService.shouldUseUnblock(session.isNew)) {
        await browserlessSessionService.applyUnblockCookies(page, this.baseUrl);
      } else if (session.reused) {
        await this.logInfo(
          "Skipping Browserless unblock on reused session (live browser state preserved)"
        );
      }

      await this.logInfo(
        "Skipping property cookie_storage load; Browserless session persists cookies by account email"
      );

      // Navigate to login page
      await this.logInfo("Navigating to Booking.com admin portal");
      await this.navigateWithStaleTabRecovery(page, this.baseUrl, loadingTimeout);

      await this.takeScreenshot();

      return { browser, page };
    } catch (error) {
      await this.logError("Browser setup failed", error);
      throw error;
    }
  }

  /**
   * Setup local browser for development/testing.
   * LOCAL_BROWSER=true → system Chrome + per-email userDataDir (persisted session).
   * Otherwise → bundled Chromium, fresh profile each run (existing behavior).
   */
  private async setupLocalBrowser(
    jobId?: string,
    loginEmail?: string
  ): Promise<{ browser: Browser; page: Page }> {
    if (localChromeSessionService.isEnabled()) {
      return this.setupLocalChromeProfileBrowser(jobId, loginEmail);
    }
    return this.setupEphemeralLocalBrowser(jobId);
  }

  private async setupLocalChromeProfileBrowser(
    jobId?: string,
    loginEmail?: string
  ): Promise<{ browser: Browser; page: Page }> {
    try {
      const resolvedEmail = await this.resolveBookingLoginEmail(jobId, loginEmail);
      await this.logInfo(
        "LOCAL_BROWSER enabled — launching system Chrome with userDataDir profile",
        { loginEmail: resolvedEmail ?? localChromeSessionService.getDefaultProfileEmail() }
      );

      const loadingTimeout = jobId
        ? await timeoutManager.getLoadingTimeout(jobId)
        : 120000;
      const selectorTimeout = jobId
        ? await timeoutManager.getSelectorTimeout(jobId)
        : 30000;

      const { browser, page, userDataDir, reusedProfile } =
        await localChromeSessionService.launchForEmail(resolvedEmail);

      this.usingLocalChromeProfile = true;

      await this.applyAntiDetection(page);
      await page.setDefaultNavigationTimeout(loadingTimeout);
      await page.setDefaultTimeout(selectorTimeout);

      await this.logInfo(
        reusedProfile
          ? "Reusing existing Chrome user profile from disk"
          : "Created new Chrome user profile (first run for this email)",
        { userDataDir }
      );

      await this.logInfo(
        "Skipping property cookie_storage; Chrome userDataDir persists session by email"
      );

      await this.logInfo("Navigating to Booking.com admin portal");
      try {
        await page.goto(this.baseUrl, {
          waitUntil: "networkidle2",
          timeout: loadingTimeout,
        });
      } catch {
        await this.logInfo("Navigation slow, trying with domcontentloaded");
        await page.goto(this.baseUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await this.delay(5000);
      }

      await this.takeScreenshot();
      await this.logInfo("Local Chrome profile browser setup completed");
      return { browser, page };
    } catch (error) {
      await this.logError("Local Chrome profile browser setup failed", error);
      throw error;
    }
  }

  private async setupEphemeralLocalBrowser(
    jobId?: string
  ): Promise<{ browser: Browser; page: Page }> {
    try {
      await this.logInfo("Setting up local browser for Booking.com");

      // Get timeout configuration
      const loadingTimeout = jobId
        ? await timeoutManager.getLoadingTimeout(jobId)
        : 120000;
      const selectorTimeout = jobId
        ? await timeoutManager.getSelectorTimeout(jobId)
        : 30000;

      // Launch local browser with comprehensive anti-detection
      const browser = await puppeteer.launch({
        headless: true, // Set to false so you can see the browser
        defaultViewport: null,
        args: [
          "--start-maximized",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-web-security",
          "--disable-features=IsolateOrigins,site-per-process",
          "--disable-blink-features=AutomationControlled",
          "--disable-extensions",
          // Additional stealth args to avoid detection
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-features=TranslateUI",
          "--disable-ipc-flooding-protection",
          "--no-first-run",
          "--no-default-browser-check",
          "--no-pings",
          "--password-store=basic",
          "--use-mock-keychain",
          "--excludeSwitches=enable-automation",
          "--disable-automation",
          "--disable-infobars",
        ],
      });

      const page = await browser.newPage();

      await this.applyAntiDetection(page);

      // Set default timeouts
      await page.setDefaultNavigationTimeout(loadingTimeout);
      await page.setDefaultTimeout(selectorTimeout);

      // Load saved cookies if they exist for the current property
      if (this.propertyIdForDb) {
        const cookies = await cookieStorageService.loadCookies(
          this.propertyIdForDb,
          PlatformsType.BOOKING
        );
        if (cookies) {
          await page.setCookie(...cookies);
          await this.logInfo(
            `Loaded ${cookies.length} cookies from storage for property ${this.propertyIdForDb}`
          );
        } else {
          await this.logInfo("No saved cookies found for this property");
        }
      }

      // Navigate to login page
      await this.logInfo("Navigating to Booking.com admin portal");
      try {
        await page.goto(this.baseUrl, {
          waitUntil: "networkidle2",
          timeout: loadingTimeout,
        });
      } catch (navError) {
        await this.logInfo("Navigation slow, trying with domcontentloaded");
        await page.goto(this.baseUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await this.delay(5000);
      }

      await this.takeScreenshot();
      await this.logInfo("Local browser setup completed successfully");

      return { browser, page };
    } catch (error) {
      await this.logError("Local browser setup failed", error);
      throw error;
    }
  }

  /**
   * Apply comprehensive anti-bot-detection to any Puppeteer page/tab.
   * Must be called on EVERY page object before it navigates — including new tabs
   * opened via targetcreated — because evaluateOnNewDocument, userAgent, and
   * headers are per-page and do NOT inherit from the parent page.
   */
  private async applyAntiDetection(page: Page): Promise<void> {
    try {
      const hadProfile = Boolean(this.browserProfile);
      this.browserProfile = await applyBookingAntiDetection(
        page,
        this.browserProfile
      );
      if (
        !hadProfile &&
        this.browserProfile.detectedIp &&
        this.browserProfile.detectedCountryCode
      ) {
        await this.logInfo("Browser profile matched to egress IP", {
          platform: this.browserProfile.browserPlatform,
          ip: this.browserProfile.detectedIp,
          country: this.browserProfile.detectedCountryCode,
          timezone: this.browserProfile.timezone,
          guestCountry: this.browserProfile.guestCountry,
          locale: this.browserProfile.locale,
        });
      }
    } catch (err) {
      console.error("[applyAntiDetection] failed:", err);
    }
  }

  /**
   * Handle property search after successful login or when already logged in
   */
  private async handlePropertySearch(propertyId?: string): Promise<void> {
    if (!propertyId) {
      await this.logInfo("No property ID provided, skipping property search");
      return;
    }

    await this.logInfo(
      "Checking for multi-property account and searching for property"
    );
    const isMultiProperty = await this.checkMultiPropertyAccount();

    if (isMultiProperty) {
      await this.logInfo(
        "Multi-property account detected, searching for property"
      );
      const searchSuccess = await this.searchProperty(propertyId);
      if (searchSuccess) {
        await this.logInfo(
          "Property search and selection completed successfully"
        );
      } else {
        await this.logError("Property search failed");
      }
    } else {
      await this.logInfo(
        "Single property account detected, no property search needed"
      );
    }
  }

  /**
   * Handle successful login completion
   */
  private async handleSuccessfulLogin(propertyId?: string): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");

    await this.logInfo("✅ Login successful");

    // First-pass extraction: works for single-property landings where ses/lang
    // are already in the URL. For multi-property selector pages this comes back
    // empty and we rely on the post-search URL below.
    await this.extractSessionParams();

    // Map MongoDB ObjectId (property _id) to actual Booking hotel id if needed
    let effectivePropertyId = propertyId;
    if (effectivePropertyId && Types.ObjectId.isValid(effectivePropertyId)) {
      try {
        const propertyRecord = await Property.findById(
          effectivePropertyId
        ).lean();
        if (propertyRecord && propertyRecord.booking_id) {
          await this.logInfo(
            `Property id passed as MongoDB id. Mapping to booking id: ${propertyRecord.booking_id}`
          );
          this.setPropertyIdForDb(effectivePropertyId);
          effectivePropertyId = propertyRecord.booking_id.toString();
        } else {
          await this.logInfo(
            `Property id passed as MongoDB id but booking_id not found for ${effectivePropertyId}`
          );
        }
      } catch (err) {
        await this.logError(`Error mapping MongoDB id to booking id: ${err}`);
      }
    }

    // We need to be on the SPECIFIC property's extranet page so the top nav and
    // its menu sections (Home, Reservations, Finance/VCCS, etc.) actually render.
    // Note: ses/lang alone are NOT enough — the multi-property `/groups/home/`
    // page also has them in the URL but does not render the property nav.
    if (this.isOnSpecificPropertyPage(effectivePropertyId)) {
      await this.logInfo(
        `Already on property page${
          effectivePropertyId ? ` for hotel_id=${effectivePropertyId}` : ""
        } - skipping property search`
      );
    } else {
      await this.handlePropertySearch(effectivePropertyId);
    }

    // At this point we're on a property's extranet page (either we landed there
    // directly OR we just selected one), so the top nav is rendered. Mimic real
    // user browsing (Home → Reservations + scrolls) to reduce the bot signature
    // of jumping straight from sign-in to a deep admin page. Non-fatal: any
    // failure is logged and swallowed so the main login flow continues.
    await this.performHumanBrowsingAfterLogin();

    // Re-extract ses/lang from the canonical Home/Reservations URL — more
    // reliable than the post-login URL, and required for multi-property where
    // the first extraction above was empty.
    await this.extractSessionParams();

    // Save cookies AFTER browsing + search so cached-cookie runs start from the
    // post-search state (skipping both login AND property search next time).
    // Skip when using Browserless persisted session — cookies live in the session userDataDir.
    // Skip when using local Chrome userDataDir profile (LOCAL_BROWSER=true).
    if (!this.usingPersistentBrowserlessSession && !this.usingLocalChromeProfile) {
      const cookies = await this.page.cookies();
      if (this.propertyIdForDb) {
        const success = await cookieStorageService.saveCookies(
          this.propertyIdForDb,
          PlatformsType.BOOKING,
          cookies
        );
        if (!success) {
          await this.logWarn("Failed to save cookies to storage");
        }
      }
    } else if (this.usingLocalChromeProfile) {
      await this.logInfo(
        "Skipping property cookie_storage save; Chrome userDataDir profile persists session by email"
      );
    } else if (this.usingPersistentBrowserlessSession) {
      await this.logInfo(
        "Skipping property cookie_storage save; Browserless session persists cookies by email"
      );
    }

    await this.takeScreenshot();
  }

  /**
   * Click Home, then Reservations (with scrolling pauses in between) so the first
   * post-login action is not always a deep-link to an admin page. Selectors follow
   * the existing `li[data-nav-tag="..."] .ext-navigation-top-item__link` convention
   * used in `BOOKING_SELECTORS.navigation`. Skipped silently if the top nav is not
   * rendered yet (e.g. multi-property selector page where a property has not been
   * picked).
   */
  private async performHumanBrowsingAfterLogin(): Promise<void> {
    if (!this.page) return;

    const homeSelector =
      'li[data-nav-tag="home"] a.ext-navigation-top-item__link';
    const reservationsSelector =
      'li[data-nav-tag="reservations"] a.ext-navigation-top-item__link';

    try {
      const homeNav = await this.page.$(homeSelector);
      if (!homeNav) {
        await this.logInfo(
          "Top nav not present yet — skipping human-like browsing"
        );
        return;
      }

      await this.logInfo(
        "Performing human-like browsing (Home → Reservations)"
      );

      await this.clickNavAndWait(homeSelector, "home.html");
      await this.scrollHumanLike();

      const reservationsNav = await this.page.$(reservationsSelector);
      if (reservationsNav) {
        await this.clickNavAndWait(
          reservationsSelector,
          "search_reservations.html"
        );
        await this.scrollHumanLike();
      } else {
        await this.logInfo(
          "Reservations link not found after Home — skipping that hop"
        );
      }

      await this.logInfo("Human-like browsing complete");
    } catch (err) {
      await this.logWarn("Human-like browsing step failed (non-fatal)", err);
    }
  }

  /**
   * Click a top-nav link and wait for the destination to fully load. Tolerates
   * the case where the click does not trigger a full navigation (e.g. SPA route).
   *
   * Booking can throw a fresh captcha, 2FA prompt, account-lock, or password-reset
   * interstitial mid-session after any click — even when already logged in. After
   * the navigation settles we drain those via {@link resolveBookingAuthInterstitials},
   * the same helper {@link login} uses. If Booking bounces us back to /sign-in
   * (session expired), we throw so the caller's try/catch can abort the human-like
   * browsing cleanly; the downstream `checkIfLoginNeeded` → `login(..., true)`
   * pattern in `vccs-management.service.ts` will pick up a fresh login from there.
   */
  private async clickNavAndWait(
    selector: string,
    expectedUrlSubstring: string
  ): Promise<void> {
    if (!this.page) return;

    const navPromise = this.page
      .waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 })
      .catch(() => undefined);

    await this.page.click(selector);
    await navPromise;
    await delay(1500);

    // Drain any captcha / 2FA / account-lock / password-reset interstitial that
    // Booking may have served on this navigation. Smaller maxRounds than the
    // post-login drain because the page should already be authenticated.
    const resolved = await this.resolveBookingAuthInterstitials({
      loginEmail: this.credentials?.email,
      maxRounds: 4,
    });
    if (!resolved) {
      await this.logWarn(
        `Auth interstitial not fully resolved after nav click to ${expectedUrlSubstring}; continuing best-effort`
      );
    }

    const currentUrl = this.page.url();

    // Bounced back to sign-in (session expired). Don't recurse into login() from
    // here — let the outer flow handle re-authentication via its existing path.
    if (currentUrl.toLowerCase().includes("/sign-in")) {
      throw new Error(
        `Bounced to sign-in after nav click to ${expectedUrlSubstring} (current: ${currentUrl})`
      );
    }

    if (currentUrl.includes(expectedUrlSubstring)) {
      await this.logInfo(`Navigated to ${expectedUrlSubstring}`);
    } else {
      await this.logInfo(
        `Nav did not land on ${expectedUrlSubstring} (current: ${currentUrl}) — continuing`
      );
    }
  }

  /**
   * Scroll the page down in small randomized steps, pause as if reading, then
   * scroll back to the top. Distances and pauses vary per call to avoid a
   * uniform scroll signature.
   */
  private async scrollHumanLike(): Promise<void> {
    if (!this.page) return;

    const downSteps = 3 + Math.floor(Math.random() * 3); // 3–5 steps
    for (let i = 0; i < downSteps; i++) {
      const px = 200 + Math.floor(Math.random() * 200); // 200–400 px
      await this.page.evaluate((y) => window.scrollBy(0, y), px);
      await delay(400 + Math.floor(Math.random() * 600));
    }

    await delay(1000 + Math.floor(Math.random() * 1500));

    const upSteps = 3 + Math.floor(Math.random() * 2); // 3–4 steps
    for (let i = 0; i < upSteps; i++) {
      const px = 200 + Math.floor(Math.random() * 250); // 200–450 px
      await this.page.evaluate((y) => window.scrollBy(0, -y), px);
      await delay(300 + Math.floor(Math.random() * 400));
    }

    await this.page.evaluate(() => window.scrollTo(0, 0));
    await delay(500);
  }

  /**
   * Decide whether the current URL is the specific property's extranet page.
   * Used to decide if `handlePropertySearch` is necessary: ses/lang alone are NOT
   * enough — `/hoteladmin/groups/home/...?ses=…&lang=xu` (multi-property landing)
   * also has them but doesn't render the property-scoped top nav. We require
   * `hotel_id=<propertyId>` in the URL.
   */
  private isOnSpecificPropertyPage(propertyId?: string): boolean {
    if (!this.page) return false;
    const url = this.page.url();
    if (!url.includes("hotel_id=")) return false;
    if (propertyId) {
      return url.includes(`hotel_id=${propertyId}`);
    }
    return true;
  }

  /**
   * Check if user is already logged in
   */
  private isAlreadyLoggedInOnPage(page: Page | null | undefined): boolean {
    if (!page) return false;

    const finalUrl = page.url();

    const isIncluded = BOOKING_LOGIN_SUCCESS_URLS.some((url) =>
      finalUrl.includes(url)
    );
    const isExcluded = BOOKING_LOGIN_EXCLUDE_URLS.some((url) =>
      finalUrl.includes(url)
    );

    return isIncluded && !isExcluded;
  }

  private isAlreadyLoggedIn(): boolean {
    return this.isAlreadyLoggedInOnPage(this.page);
  }

  /**
   * Parse `ses` and `lang` from Booking URLs. Secure-admin often uses semicolons as query
   * separators (`?hotel_id=1;lang=xu;bn=…;ses=…`), which `URLSearchParams` does not split,
   * so `searchParams.get("ses")` stays null and the next reservation opens without a session.
   */
  private parseSesAndLangFromBookingUrl(url: string): {
    ses: string | null;
    lang: string | null;
  } {
    try {
      const urlObj = new URL(url);
      let ses = urlObj.searchParams.get("ses");
      let lang = urlObj.searchParams.get("lang");
      if (ses && lang) {
        return { ses, lang };
      }
      const q = urlObj.search;
      if (!q || q === "?") {
        return { ses, lang };
      }
      const raw = q.startsWith("?") ? q.slice(1) : q;
      const params = new Map<string, string>();
      for (const part of raw.split(/[&;]+/)) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const keyPart = trimmed.slice(0, eq).trim();
        const valPart = trimmed.slice(eq + 1).trim();
        let k: string;
        let v: string;
        try {
          k = decodeURIComponent(keyPart);
          v = decodeURIComponent(valPart);
        } catch {
          k = keyPart;
          v = valPart;
        }
        if (k) params.set(k, v);
      }
      if (!ses) ses = params.get("ses") ?? null;
      if (!lang) lang = params.get("lang") ?? null;
      return { ses, lang };
    } catch {
      return { ses: null, lang: null };
    }
  }

  /**
   * Extract session (ses) and language (lang) parameters from current URL
   */
  private async extractSessionParams(): Promise<void> {
    if (!this.page) {
      await this.logWarn("Page not initialized, cannot extract session params");
      return;
    }

    try {
      const currentUrl = this.page.url();
      await this.logInfo(
        `Extracting session parameters from URL: ${currentUrl}`
      );

      const { ses, lang: langRaw } =
        this.parseSesAndLangFromBookingUrl(currentUrl);
      const lang = langRaw ?? (ses ? "xu" : null);

      if (ses && lang) {
        this.sessionParams = { ses, lang };
        await this.logInfo(
          `✅ Session parameters extracted - ses: ${ses}, lang: ${lang}`
        );
      } else {
        await this.logWarn(
          `Session parameters not found in URL. ses: ${ses}, lang: ${langRaw}`
        );
      }
    } catch (error) {
      await this.logError("Error extracting session parameters", error);
    }
  }

  private isStalePageNavigationError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return (
      msg.includes("detached Frame") ||
      msg.includes("detached frame") ||
      msg.includes("Execution context was destroyed") ||
      msg.includes("Target closed") ||
      msg.includes("Navigating frame was detached")
    );
  }

  /** Max wait for a CDP evaluate probe before treating the tab as frozen. */
  private static readonly PAGE_PROBE_TIMEOUT_MS = 8_000;

  /**
   * Returns true when the page can run a trivial evaluate (renderer + CDP are responsive).
   */
  private async probePageResponsive(
    page: Page,
    timeoutMs = BookingScraper.PAGE_PROBE_TIMEOUT_MS
  ): Promise<boolean> {
    if (page.isClosed()) {
      return false;
    }
    try {
      await Promise.race([
        page.evaluate(() => true),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Page probe timeout")), timeoutMs)
        ),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reload a frozen tab in-place (same session cookies/profile). Mirrors what a Live URL reload does.
   */
  private async recoverPageByReload(
    page: Page,
    loadingTimeout = 90_000
  ): Promise<boolean> {
    if (page.isClosed()) {
      return false;
    }
    try {
      await page.reload({
        waitUntil: "domcontentloaded",
        timeout: loadingTimeout,
      });
      await this.delay(1500);
      return await this.probePageResponsive(page);
    } catch {
      return false;
    }
  }

  /**
   * Keep the tab in an active, focused lifecycle state and warm the renderer before real navigation.
   * Reduces frozen tabs after reconnecting to a persisted Browserless session.
   */
  private async activatePageForAutomation(page: Page): Promise<void> {
    try {
      await page.bringToFront();
    } catch {
      /* non-fatal */
    }

    try {
      const cdp = await page.createCDPSession();
      await cdp.send("Page.setWebLifecycleState", { state: "active" });
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    } catch (error) {
      await this.logWarn(
        "Could not mark Browserless tab as active via CDP",
        error
      );
    }

    if (await this.probePageResponsive(page, 3_000)) {
      return;
    }

    try {
      await page.goto("about:blank", {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      await this.delay(500);
    } catch {
      /* warmup navigation is best-effort */
    }

    if (await this.probePageResponsive(page)) {
      return;
    }

    await this.logWarn(
      "Browserless tab unresponsive after warmup; reloading in same session"
    );
    await this.recoverPageByReload(page, 30_000);
  }

  /**
   * Navigate with domcontentloaded, then reload if the tab is still unresponsive.
   */
  private async navigateWithStaleTabRecovery(
    page: Page,
    url: string,
    loadingTimeout: number
  ): Promise<void> {
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: loadingTimeout,
      });
    } catch (navError) {
      await this.logInfo("Navigation slow or timed out; continuing after domcontentloaded", {
        url,
        error: navError instanceof Error ? navError.message : String(navError),
      });
    }

    await this.delay(2000);

    if (await this.probePageResponsive(page)) {
      return;
    }

    await this.logWarn(
      "[booking] Tab unresponsive after navigation; reloading in same Browserless session",
      { url }
    );
    await this.recoverPageByReload(page, loadingTimeout);
  }

  /**
   * Attach to a Browserless session tab. Reused sessions always get a fresh tab so prior
   * frozen/stale tabs are not inherited (session cookies/profile are unchanged).
   */
  private async prepareBrowserlessPage(
    browser: Browser,
    reusedSession: boolean
  ): Promise<Page> {
    const openPages = (await browser.pages()).filter((p) => !p.isClosed());

    if (!reusedSession) {
      return openPages.length > 0 ? openPages[0] : await browser.newPage();
    }

    const page = await browser.newPage();
    await this.logInfo(
      "Opened fresh tab on reused Browserless session (closing prior tabs; cookies preserved)",
      { priorTabCount: openPages.length }
    );

    for (const oldTab of openPages) {
      if (oldTab === page || oldTab.isClosed()) {
        continue;
      }
      try {
        await oldTab.close();
      } catch {
        /* ignore */
      }
    }

    return page;
  }

  /**
   * Extranet flows can detach the main frame or leave `this.page` on a stale tab. Ensure we target an
   * attached page (prefer admin.booking.com) before `goto`.
   */
  private async ensureUsablePageForNavigation(): Promise<boolean> {
    if (!this.browser) {
      await this.logError("ensureUsablePageForNavigation: browser not initialized");
      return false;
    }

    const probe = async (p: Page): Promise<boolean> => {
      if (p.isClosed()) return false;
      try {
        await p.evaluate(() => true);
        return true;
      } catch {
        return false;
      }
    };

    if (this.page && (await probe(this.page))) {
      return true;
    }

    const pages = await this.browser.pages();
    const open = pages.filter((p) => !p.isClosed());

    const adopt = async (p: Page): Promise<boolean> => {
      if (!(await probe(p))) return false;
      this.page = p;
      try {
        await p.bringToFront();
      } catch {
        /* non-fatal */
      }
      let url = "";
      try {
        url = p.url();
      } catch {
        url = "(url unreadable)";
      }
      await this.logInfo(
        `[booking] Using attached page for navigation: ${url}`
      );
      return true;
    };

    for (const p of [...open].reverse()) {
      let url = "";
      try {
        url = p.url();
      } catch {
        continue;
      }
      if (
        url.includes("admin.booking.com") ||
        url.includes("extranet_ng") ||
        url.includes("account.booking.com")
      ) {
        if (await adopt(p)) return true;
      }
    }

    for (const p of [...open].reverse()) {
      if (await adopt(p)) return true;
    }

    await this.logError(
      "ensureUsablePageForNavigation: no attached page found in browser"
    );
    return false;
  }

  /**
   * Get the latest password from database for the current booking property
   * This ensures we always use the most up-to-date password throughout the scraping process
   */
  async getLatestBookingPassword(): Promise<string | null> {
    try {
      if (!this.jobId) {
        await this.logInfo(
          "No jobId available, cannot fetch latest password from database"
        );
        return null;
      }

      const credentials =
        await propertyCredentialsService.getBookingCredentialsFromJob(
          this.jobId
        );

      if (credentials?.bookingPassword) {
        const decryptedPassword = decryptPassword(credentials.bookingPassword);
        return decryptedPassword;
      }

      return null;
    } catch (error) {
      await this.logError("Failed to fetch password from database", error);
      return null;
    }
  }

  /**
   * Loads username/password from the property linked to jobId. Used for booking groups so each
   * step uses that job's row in the DB (e.g. after job 1 updates the password, job 2 reads the new value).
   */
  private async applyBookingCredentialsForJob(
    jobId: string,
    fallback?: LoginCredentials
  ): Promise<void> {
    try {
      const latest =
        await propertyCredentialsService.getBookingCredentialsFromJob(jobId);
      if (latest?.bookingUsername && latest?.bookingPassword) {
        this.credentials = {
          email: latest.bookingUsername,
          password: decryptPassword(latest.bookingPassword),
        };
        await this.logInfo(
          `Using Booking credentials from database for job ${jobId}`
        );
        return;
      }
    } catch (err) {
      await this.logWarn(
        `Could not load Booking credentials from database for job ${jobId}`,
        err
      );
    }
    if (fallback?.email && fallback.password) {
      this.credentials = { ...fallback };
      await this.logWarn(
        `Using fallback credentials for job ${jobId} (database incomplete or missing)`
      );
      return;
    }
    throw new Error(
      `No Booking credentials for job ${jobId} (database and fallback both unavailable)`
    );
  }

  async login(
    credentials?: LoginCredentials,
    propertyId?: string,
    skipAlreadyLogged?: boolean
  ): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");

    const loginCredentials = credentials || this.credentials;
    if (!loginCredentials) {
      throw new Error(
        "No credentials provided for login. Please provide credentials or set them on the scraper instance."
      );
    }

    // Always fetch the freshest credentials from the database using jobId
    let effectiveCredentials: LoginCredentials = { ...loginCredentials };
    if (this.jobId) {
      try {
        await this.logInfo(
          `Fetching latest Booking.com credentials from database for job ${this.jobId}...`
        );
        const latest =
          await propertyCredentialsService.getBookingCredentialsFromJob(
            this.jobId
          );

        if (latest?.bookingPassword) {
          effectiveCredentials = {
            email: latest.bookingUsername || effectiveCredentials.email,
            password: decryptPassword(latest.bookingPassword),
          };
          // Using latest credentials from database
        }
      } catch (err) {
        await this.logWarn(
          "Using provided credentials (database fetch failed)",
          err
        );
      }
    }

    try {
      // Check if scraping should continue before login
      await this.throwIfScrapingShouldStop("login");

      if (this.isAlreadyLoggedIn() && !skipAlreadyLogged) {
        await this.logInfo("✅ Already logged in");

        // Reuse the same post-login flow as a fresh login so the cookie-load
        // path also gets: property-search-if-needed → human-like browsing →
        // ses/lang refresh → cookie re-save (captures any Booking-side session
        // refresh) → screenshot. Avoids drift between the two code paths.
        await this.handleSuccessfulLogin(propertyId);
        return;
      }

      await this.logInfo("🔐 Starting login process");

      await this.handleCaptcha({
        sessionUrl: this.sessionUrl,
      });

      await this.logInfo("Entering email address");

      try {
        await simulateHumanMouseMove(this.page!);
      } catch {
        // Non-fatal
      }

      // Check if scraping should continue before entering email
      await this.throwIfScrapingShouldStop("enter_email");

      await this.takeScreenshot("email_page_loaded");

      const emailEntered = await this.enterEmail(effectiveCredentials.email);
      if (!emailEntered) {
        await this.takeScreenshot();
        throw new Error("Email field not found");
      }

      await this.logInfo("Clicking Continue with email");
      await this.takeScreenshot("email_entered");
      const continueClicked = await this.clickContinueButton();

      if (!continueClicked) {
        throw new Error("Continue Button not found");
      }

      await this.takeScreenshot();
      await this.delay(5000);

      // Check for captcha after email submission
      await this.handleCaptcha({
        sessionUrl: this.sessionUrl,
      });

      await this.logInfo("Looking for password field");

      let passwordField = null;
      let attempts = 0;
      const maxAttempts = 6;

      while (!passwordField && attempts < maxAttempts) {
        for (const selector of BOOKING_SELECTORS.password) {
          try {
            passwordField = await this.page.$(selector);
            if (passwordField) {
              const isVisible = await passwordField.isIntersectingViewport();
              if (isVisible) {
                await this.logInfo(`Password field found: ${selector}`);
                break;
              } else {
                passwordField = null;
              }
            }
          } catch (e) {
            // Try next selector
            continue;
          }
        }

        if (!passwordField) {
          attempts++;
          await this.logInfo(
            `Attempt ${attempts}/${maxAttempts} - waiting for password field`
          );
          await this.delay(5000);
        }
      }

      if (!passwordField) {
        await this.takeScreenshot();
        throw new Error("Password field not found after multiple attempts");
      }

      // Check if scraping should continue before entering password
      await this.throwIfScrapingShouldStop("enter_password");

      // Enter password using the new function
      const passwordEntered = await this.enterPassword(
        effectiveCredentials.password
      );
      if (!passwordEntered) {
        await this.takeScreenshot();
        throw new Error("Failed to enter password");
      }

      await this.logInfo("Submitting login");

      const loginClicked = await this.clickLoginButton();
      if (!loginClicked) {
        throw new Error("Login Button not found");
      }

      // Check for captcha after login submission
      await this.handleCaptcha({
        sessionUrl: this.sessionUrl,
      });

      await this.takeScreenshot();

      // Wait for navigation
      await this.page
        .waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 })
        .catch(() => {});

      await this.delay(2000);
      await this.assertBookingSignInFatalErrors();

      // Booking may return captcha, account lock, password reset, or 2FA in any order and more than once
      const authResolved = await this.resolveBookingAuthInterstitials({
        loginEmail: effectiveCredentials.email,
      });

      if (!authResolved || !this.isAlreadyLoggedIn()) {
        await this.checkLoginErrors();

        if (!this.isAlreadyLoggedIn()) {
          await this.takeScreenshot();
          const currentUrl = this.page!.url();
          const html = await this.page!.content();
          const looksLike2FA =
            TWO_FA_PATTERNS.some((p) => currentUrl.includes(p)) ||
            TWO_FA_TEXT_PATTERNS.some((t) => html.includes(t));
          if (looksLike2FA) {
            await dualLogError(
              getBookingErrorDescription(BookingErrorType.TWO_FA_ERROR),
              {
                errorType: BookingErrorType.TWO_FA_ERROR,
                phase: BookingScrapingPhase.LOGIN,
                platform: "booking",
              }
            );
            const twoFaErr = new Error("2FA verification failed");
            setFailedReasonCode(twoFaErr, FAILED_REASON.BOOKING_2FA_FAILED);
            throw twoFaErr;
          }
          await dualLogError(
            getBookingErrorDescription(BookingErrorType.LOGIN_FAILED),
            {
              errorType: BookingErrorType.LOGIN_FAILED,
              phase: BookingScrapingPhase.LOGIN,
              platform: "booking",
            }
          );
          const incompleteErr = new Error(
            "Login did not complete — unexpected page after auth challenges"
          );
          setFailedReasonCode(
            incompleteErr,
            FAILED_REASON.BOOKING_LOGIN_FAILED
          );
          throw incompleteErr;
        }
      }

      await this.handleSuccessfulLogin(propertyId);
    } catch (error: any) {
      await dualLogError(
        getBookingErrorDescription(BookingErrorType.LOGIN_FAILED),
        {
          errorType: BookingErrorType.LOGIN_FAILED,
          error: error,
          phase: BookingScrapingPhase.LOGIN,
          platform: "booking",
        }
      );
      await this.takeScreenshot();
      if (!hasFailedReasonCode(error)) {
        setFailedReasonCode(error, FAILED_REASON.BOOKING_LOGIN_FAILED);
      }
      throw error;
    }
  }

  /**
   * Check if the logged-in account has multiple properties
   * This method checks for the multi-property URL pattern
   */
  async checkMultiPropertyAccount(): Promise<boolean> {
    if (!this.page) throw new Error("Page not initialized");

    try {
      const currentUrl = this.page.url();
      await this.logInfo(
        `Checking multi-property account. Current URL: ${currentUrl}`
      );

      // Check if URL contains multi-property indicators
      const isMultiProperty =
        currentUrl.includes("/groups/home/") ||
        currentUrl.includes("hoteladmin/groups/") ||
        currentUrl.includes("multi-property");

      await this.logInfo(`Multi-property account detected: ${isMultiProperty}`);
      return isMultiProperty;
    } catch (error) {
      await this.logError("Error checking multi-property account:", error);
      return false;
    }
  }

  private async checkIfLoginNeeded(page?: Page): Promise<boolean> {
    const currentPage = page || this.page;
    if (!currentPage) throw new Error("Page not initialized");

    try {
      const hasLoginForm = await SelectorUtils.trySelectors(
        currentPage,
        [...BOOKING_SELECTORS.email, ...BOOKING_SELECTORS.password],
        async (selector: string) => {
          const el = await currentPage!.$(selector);
          return !!el;
        },
        5000
      );

      if (hasLoginForm) {
        await this.logInfo("Login required detected via URL or form elements");
        return true;
      }

      await this.logInfo("No login required detected");
      return false;
    } catch (error) {
      await this.logError("Error checking if login is needed:", error);
      return false;
    }
  }

  async searchProperty(propertyId: string): Promise<boolean> {
    if (!this.page) throw new Error("Page not initialized");

    try {
      await this.logInfo(`Searching for property ID: ${propertyId}`);

      const searchInputFound = await SelectorUtils.findAndType(
        this.page,
        BOOKING_SELECTORS.property.searchInput,
        propertyId
      );

      if (!searchInputFound) {
        await this.logError("Property search input not found");
        await this.takeScreenshot();
        return false;
      }

      await this.logInfo("Property ID entered in search field");

      // Wait a bit for search results to load
      await this.delay(2000);

      await this.takeScreenshot();

      const propertySelectors = BOOKING_SELECTORS.property.item(propertyId);

      const propertyClicked = await SelectorUtils.findAndClick(
        this.page,
        propertySelectors
      );

      if (!propertyClicked) {
        await this.logInfo(
          "Property not found with predefined selectors, trying alternative approaches..."
        );

        // Try alternative approach - look for any link containing the property ID
        const alternativeClicked = await this.page.evaluate((propertyId) => {
          const links = Array.from(
            document.querySelectorAll('a[href*="hotel_id"]')
          );
          console.log(`Found ${links.length} links with hotel_id in href`);

          for (const link of links) {
            const href = link.getAttribute("href");
            const text = link.textContent?.trim();
            console.log(`Link href: ${href}, text: ${text}`);

            if (href && href.includes(`hotel_id=${propertyId}`)) {
              console.log(`Found matching link: ${href}`);
              (link as HTMLElement).click();
              return true;
            }
          }

          // Try looking for links with the property ID as text
          const textLinks = Array.from(document.querySelectorAll("a"));
          for (const link of textLinks) {
            const text = link.textContent?.trim();
            if (text === propertyId) {
              console.log(`Found link with matching text: ${text}`);
              (link as HTMLElement).click();
              return true;
            }
          }

          return false;
        }, propertyId);

        if (alternativeClicked) {
          await this.logInfo(
            "Property found and clicked using alternative method"
          );
        } else {
          await dualLogError(
            `[${new Date().toISOString()}] ${getBookingErrorDescription(
              BookingErrorType.PROPERTY_NOT_FOUND
            )}`,
            {
              errorType: BookingErrorType.PROPERTY_NOT_FOUND,
              phase: BookingScrapingPhase.NAVIGATION,
              platform: "booking",
            }
          );
          await this.logError("Property not found with any method");
          return false;
        }
      } else {
        await this.logInfo(
          "Property clicked successfully with predefined selectors"
        );
      }

      // Handle property selection - try multiple approaches for reliability
      let pageSwitched = false;

      try {
        // Approach 1: Listen for new page creation (works in browserless)
        const newPagePromise = new Promise<Page>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Timeout waiting for new page"));
          }, 10000);

          this.browser!.once("targetcreated", async (target) => {
            clearTimeout(timeout);
            if (target.type() === "page") {
              const newPage = await target.page();
              await this.applyAntiDetection(newPage!);
              await newPage!.bringToFront();
              resolve(newPage!);
            }
          });
        });

        // Wait for the new page to be created
        const newPage = await newPagePromise;
        this.page = newPage;
        pageSwitched = true;
        await this.logInfo(
          `Switched to new page via event: ${this.page.url()}`
        );
      } catch (error) {
        await this.logInfo(
          "Event-based page detection failed, trying alternative approach"
        );

        // Approach 2: Wait and check for new pages (works locally)
        await delay(3000);

        const pages = await this.browser!.pages();
        let newPage: Page | null = null;

        // Find the page that's different from the current one
        for (const page of pages) {
          if (page !== this.page) {
            const url = page.url();
            // Check if this is the property page we're looking for
            if (url.includes("hotel_id=") || url.includes("extranet_ng")) {
              newPage = page;
              break;
            }
          }
        }

        // If no new page found, try to get the most recent page
        if (!newPage && pages.length > 1) {
          newPage = pages[pages.length - 1];
        }

        if (newPage) {
          this.page = newPage;
          await this.page.bringToFront();
          pageSwitched = true;
          await this.logInfo(
            `Switched to new page via enumeration: ${this.page.url()}`
          );
        } else {
          await this.logInfo(
            "No new page detected, continuing with current page"
          );
        }
      }

      try {
        // Verify property is selected by checking URL
        const currentUrl = this.page.url();
        await this.logInfo(`New page URL: ${currentUrl}`);

        if (currentUrl.includes(`hotel_id=${propertyId}`)) {
          await this.logInfo("Property selection verified via URL");
          await this.takeScreenshot();
          return true;
        } else {
          await this.logInfo(
            "Property selection verification failed, checking if login is needed"
          );
          await this.takeScreenshot();

          // Check if we need to login again
          const needsLogin = await this.checkIfLoginNeeded();
          if (needsLogin) {
            await this.logInfo("Login required, attempting to login again");
            return false; // Indicate login is needed
          } else {
            await this.logInfo(
              "Property selection verification inconclusive but no login needed"
            );
            return true;
          }
        }
      } catch (error) {
        await this.logError("Error in property verification:", error);
        return false;
      }
    } catch (error) {
      await this.logError("Error searching and selecting property:", error);
      await this.takeScreenshot();
      return false;
    }
  }

  async handleCaptcha(options?: CaptchaHandlerOptions): Promise<boolean> {
    const currentPage = options?.page || this.page;

    if (!currentPage) return false;

    try {
      const pageContent = await currentPage.content();
      const hasCaptcha = CAPTCHA_PATTERNS.some((pattern) =>
        pattern.test(pageContent)
      );

      if (!hasCaptcha) {
        await this.logInfo("No captcha detected");
        return true;
      }

      await this.logInfo("Captcha detected");
      await this.takeScreenshot();

      // wait fo page
      await this.delay(20000);

      // Start recording and generate live URL for captcha solving (Browserless only)
      const environment = process.env.ENVIRONMENT || "browserless";
      const isBrowserless =
        environment === "browserless" || environment === "production";

      if (isBrowserless) {
        try {
          const cdp = await currentPage.createCDPSession();
          await (cdp as any).send("Browserless.startRecording");
          await this.logInfo("Recording started successfully");

          await this.delay(2000);
          await this.logInfo(`Current page: ${currentPage.url()}`);

          try {
            /* TO DO - check with their documentation/support why this can't be increased.
              I receive "Couldn't establish a secure connection to the server." when
              trying to increase timeout.
            */
            const { liveURL } = (await (cdp as any).send(
              "Browserless.liveURL",
              {
                timeout: 600_000,
              }
            )) as { liveURL: string };

            this.sessionUrl = liveURL;
            await this.logInfo("Live URL generated for captcha solving:", {
              liveURL,
              currentPage: currentPage.url(),
            });
          } catch (liveUrlError) {
            await this.logError("Failed to generate live URL:", liveUrlError);
          }
        } catch (browserlessError) {
          await this.logInfo(
            "Browserless APIs not available (running locally?), skipping live URL generation"
          );
        }
      } else {
        await this.logInfo(
          "Running in local mode - skipping Browserless recording/live URL"
        );
      }

      let captchaSolved = false;
      const maxRetries = parseInt(process.env.CAPTCHA_MAX_RETRIES || "3");

      // Solve captcha using available methods with retry logic
      if (options?.type === "automatic") {
        // Try automatic solving with retries
        for (
          let attempt = 1;
          attempt <= maxRetries && !captchaSolved;
          attempt++
        ) {
          await this.logInfo(
            `🔄 Automatic captcha solving attempt ${attempt}/${maxRetries}`
          );
          captchaSolved = await this.solveCaptchaAutomatically();

          if (!captchaSolved && attempt < maxRetries) {
            await this.logInfo(
              `⏳ Waiting before retry attempt ${attempt + 1}`
            );
            await this.delay(2000); // Wait 2 seconds between retries
          }
        }

        // If automatic solving failed after all retries, fallback to manual
        if (!captchaSolved) {
          await this.logInfo(
            `❌ Automatic captcha solving failed after ${maxRetries} attempts, falling back to manual solving`
          );
          captchaSolved = await this.solveCaptchaManually(
            options?.timeout || 600000
          );
        }
      } else if (options?.type === "browserless_ui") {
        captchaSolved = await this.solveCaptchaWithUI(
          this.sessionUrl || options.sessionUrl!,
          options.timeout || 600000
        );
      } else {
        // Default to trying automatic first, then manual fallback
        for (
          let attempt = 1;
          attempt <= maxRetries && !captchaSolved;
          attempt++
        ) {
          await this.logInfo(
            `🔄 Automatic captcha solving attempt ${attempt}/${maxRetries}`
          );
          captchaSolved = await this.solveCaptchaAutomatically();

          if (!captchaSolved && attempt < maxRetries) {
            await this.logInfo(
              `⏳ Waiting before retry attempt ${attempt + 1}`
            );
            await this.delay(2000);
          }
        }

        // Fallback to manual solving if automatic failed
        if (!captchaSolved) {
          await this.logInfo(
            `❌ Automatic captcha solving failed after ${maxRetries} attempts, falling back to manual solving`
          );
          captchaSolved = await this.solveCaptchaManually(
            options?.timeout || 600000
          );
        }
      }

      if (!captchaSolved) {
        await dualLogError(
          `[${new Date().toISOString()}] ${getBookingErrorDescription(
            BookingErrorType.CAPTCHA
          )}`,
          {
            errorType: BookingErrorType.CAPTCHA,
            error: new Error("All CAPTCHA solving methods failed"),
            phase: BookingScrapingPhase.LOGIN,
            platform: "booking",
            action: "handle_captcha",
          }
        );
        if (this.jobId && Types.ObjectId.isValid(this.jobId)) {
          await phoneNumberSlotService.releaseByJobId(this.jobId);
        }
        return false;
      }

      return true;
    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(
          BookingErrorType.CAPTCHA
        )}`,
        {
          errorType: BookingErrorType.CAPTCHA,
          error: error,
          phase: BookingScrapingPhase.LOGIN,
          platform: "booking",
        }
      );
      return false;
    }
  }

  async handle2FA(options?: TwoFactorAuthOptions): Promise<boolean> {
    const currentPage = options?.page || this.page;

    if (!currentPage) return false;

    try {
      const currentUrl = currentPage.url();

      // Check if we're on a verification-related page
      const needsVerification = TWO_FA_PATTERNS.some((pattern) =>
        currentUrl.includes(pattern)
      );

      if (!needsVerification) {
        // Check page content for verification indicators
        const pageContent = await currentPage.content();
        const hasVerificationContent = TWO_FA_TEXT_PATTERNS.some((text) =>
          pageContent.includes(text)
        );

        if (!hasVerificationContent) {
          await this.logInfo("No 2FA required");
          return true;
        }
      }

      await this.logInfo(
        "2FA verification required, using automated OTP handler"
      );
      await this.takeScreenshot();

      try {
        await handleBookingOtpVerification(
          currentPage,
          this.jobId,
          this.propertyIdForDb
        );
        await this.logInfo("Automated OTP verification completed successfully");
        return true;
      } catch (otpError) {
        await dualLogError(
          `[${new Date().toISOString()}] [booking] Automated OTP verification failed, falling back to manual method`,
          {
            errorType: BookingErrorType.TWO_FA_ERROR,
            error: otpError,
            phase: BookingScrapingPhase.LOGIN,
            platform: "booking",
          }
        );

        // Booking.com's own server-side blocks ("Too many attempts",
        // "Card info not available", "Sign in failed — try again later",
        // "We're having technical difficulties") have no OTP field at all —
        // there's nothing for a human to enter manually no matter the
        // environment, so always rethrow immediately for these.
        if (hasNoManual2FASolvePossible(otpError)) {
          throw otpError;
        }

        // For every other automated OTP failure (wrong/missing code, code
        // not found in email, etc.) an actual OTP input does exist, so a
        // human watching the Browserless live URL could still type in the
        // right code manually. Only try that fallback when a live URL can
        // actually be generated (Browserless/production); in local mode no
        // live URL is ever generated, so there's no one to solve it and
        // waiting 5 minutes would just delay an inevitable failure.
        const environment = process.env.ENVIRONMENT || "browserless";
        const isBrowserless =
          environment === "browserless" || environment === "production";

        if (!isBrowserless) {
          await this.logInfo(
            "Running in local mode - no live URL available for manual 2FA solve, failing immediately"
          );
          throw otpError;
        }

        try {
          const cdp = await currentPage.createCDPSession();
          await (cdp as any).send("Browserless.startRecording");
          await this.logInfo("Recording started successfully");

          await this.delay(2000);
          try {
            const { liveURL } = (await (cdp as any).send(
              "Browserless.liveURL",
              {
                timeout: 600_000,
              }
            )) as { liveURL: string };

            this.sessionUrl = liveURL;
            await this.logInfo("Live URL generated for 2FA solving:", {
              liveURL,
            });
          } catch (liveUrlError) {
            await this.logError("Failed to generate live URL:", liveUrlError);
          }
        } catch (browserlessError) {
          await this.logInfo(
            "Browserless APIs not available (running locally?), skipping live URL generation for 2FA"
          );
        }

        await this.delay(300000);
        await this.logInfo("Manual 2FA timeout reached, continuing...");
        return true;
      }
    } catch (error) {
      // Preserve errors carrying a failedReasonCode (e.g. rethrown from the
      // inner catch above) — collapsing them into a plain `false` here would
      // lose the specific reason and prevent the job (and group, for the
      // fatal ones) from failing with the correct reason.
      if (hasFailedReasonCode(error)) {
        throw error;
      }

      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(
          BookingErrorType.TWO_FA_ERROR
        )}`,
        {
          errorType: BookingErrorType.TWO_FA_ERROR,
          error: error,
          phase: BookingScrapingPhase.LOGIN,
          platform: "booking",
        }
      );
      return false;
    }
  }

  /**
   * Repeatedly handles captcha, account lock, forgot-password / mismatch, and 2FA until the
   * session reaches a logged-in URL or max rounds. Booking often interleaves these pages.
   */
  async resolveBookingAuthInterstitials(options?: {
    page?: Page;
    loginEmail?: string;
    maxRounds?: number;
  }): Promise<boolean> {
    const currentPage = options?.page ?? this.page;
    if (!currentPage) {
      await this.logWarn("resolveBookingAuthInterstitials: no page");
      return false;
    }

    const maxRounds = options?.maxRounds ?? 12;
    const loginEmail = options?.loginEmail;

    for (let round = 1; round <= maxRounds; round++) {
      await this.logInfo(
        `Booking auth interstitials: round ${round}/${maxRounds}`
      );

      if (this.isAlreadyLoggedInOnPage(currentPage)) {
        await this.logInfo(
          "Success URL detected — auth interstitials complete"
        );
        return true;
      }

      await this.assertBookingSignInFatalErrors(currentPage);

      const captchaOk = await this.handleCaptcha({
        page: currentPage,
        sessionUrl: this.sessionUrl,
      });
      if (!captchaOk) {
        await this.logError(
          "Captcha handling failed during auth interstitial drain"
        );
        return false;
      }

      await currentPage
        .waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 })
        .catch(() => {});
      await this.delay(1500);

      if (this.isAlreadyLoggedInOnPage(currentPage)) {
        return true;
      }

      const twoFAOk = await this.handle2FA({ page: currentPage });
      if (!twoFAOk) {
        await this.logError("2FA failed during auth interstitial drain");
        return false;
      }

      await currentPage
        .waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 })
        .catch(() => {});
      await this.delay(1500);

      if (this.isAlreadyLoggedInOnPage(currentPage)) {
        return true;
      }
    }

    await this.logWarn(
      `Booking auth interstitials: exhausted ${maxRounds} rounds without success URL`
    );
    return false;
  }

  /** True when the given URL is Booking.com's sign-in/login page. */
  private isBookingSignInUrl(url: string): boolean {
    return url.includes("sign-in") || url.includes("login");
  }

  /**
   * Visible password-field error only — avoids false positives from bundled
   * JS/i18n strings. Booking.com's page bundle contains many translated error
   * strings (including "technical difficulties" / "sign in failed") even when
   * they aren't shown, e.g. on the 2FA/verification step — so checking
   * `page.content()` directly causes false positives. Only text actually
   * rendered in the known error selectors (or a visible `.error-block`) counts.
   */
  private async getBookingSignInVisibleError(
    page: Page = this.page!
  ): Promise<string> {
    try {
      return await page.evaluate((selectors) => {
        for (const selector of selectors) {
          const element = document.querySelector(selector);
          const text = element?.textContent?.replace(/\s+/g, " ").trim();
          if (text) {
            return text;
          }
        }

        for (const block of document.querySelectorAll("span.error-block")) {
          const rect = block.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) {
            continue;
          }
          const text = block.textContent?.replace(/\s+/g, " ").trim();
          if (text) {
            return text;
          }
        }

        return "";
      }, BOOKING_SIGN_IN_ERROR_SELECTORS);
    } catch {
      return "";
    }
  }

  /**
   * Fail immediately on a visible Booking.com sign-in error, distinguishing
   * the two cases that matter:
   *
   * - Transient server-side outages ("We're having technical difficulties",
   *   "Sign in failed, please try again later") — not a credential problem, so
   *   the caller must leave the stored verification flags alone and retry later.
   * - An outright username/password rejection — the credentials really are
   *   wrong, which is the only case allowed to mark them unverified.
   *
   * Failing here rather than looping keeps a bad password from burning every
   * remaining interstitial round before giving up.
   */
  private async assertBookingSignInFatalErrors(
    page: Page = this.page!
  ): Promise<void> {
    if (!page || !this.isBookingSignInUrl(page.url())) {
      return;
    }

    const visibleError = await this.getBookingSignInVisibleError(page);
    if (!visibleError) {
      return;
    }

    if (PASSWORD_MISMATCH_PATTERNS.some((p) => p.test(visibleError))) {
      await this.logError(
        `Booking.com rejected the credentials — failing (visible: "${visibleError}")`
      );
      await this.takeScreenshot();

      throw createBookingInvalidCredentialsError(visibleError);
    }

    if (matchesBookingTechnicalDifficulties(visibleError)) {
      await this.logError(
        `Booking.com technical difficulties — failing job (visible: "${visibleError}")`
      );
      await this.takeScreenshot();

      const err = new Error(BOOKING_TECHNICAL_DIFFICULTIES_MESSAGE);
      setFailedReasonCode(err, FAILED_REASON.BOOKING_TECHNICAL_DIFFICULTIES);
      throw err;
    }

    if (matchesBookingSignInTryAgainLater(visibleError)) {
      await this.logError(
        `Booking.com sign-in retry-later error — failing job (visible: "${visibleError}")`
      );
      await this.takeScreenshot();

      const err = new Error(BOOKING_SIGN_IN_TRY_AGAIN_LATER_MESSAGE);
      setFailedReasonCode(err, FAILED_REASON.BOOKING_SIGN_IN_TRY_AGAIN_LATER);
      throw err;
    }
  }

  async cleanup(): Promise<void> {
    try {
      // Clean up screenshots for this job
      const jobId = this.jobId || `trust_verify-${this.propertyIdForDb}`;
      if (jobId) {
        await this.logInfo(`🗑️ Cleaning up screenshots for job: ${jobId}`);
        await this.captchaService.cleanupJobScreenshots(
          jobId,
          "manual cleanup"
        );
      }

      if (this.browser) {
        if (
          this.usingPersistentBrowserlessSession &&
          browserlessSessionService.getProcessKeepAliveMs() > 0
        ) {
          await this.browser.disconnect();
          await this.logInfo(
            "Browser disconnected; persisted Browserless session kept alive"
          );
        } else if (this.usingLocalChromeProfile) {
          await this.browser.close();
          await this.logInfo(
            "Chrome closed; userDataDir profile saved for next local run"
          );
        } else {
          await this.browser.close();
          await this.logInfo("Browser closed successfully");
        }
      }
    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(
          BookingErrorType.UNKNOWN
        )}`,
        {
          errorType: BookingErrorType.UNKNOWN,
          error: error,
          phase: BookingScrapingPhase.NAVIGATION,
          platform: "booking",
          action: "cleanup",
        }
      );
    }
  }

  // Public method to access the page for trust verification
  public async getPage(): Promise<Page | null> {
    return this.page;
  }

  /**
   * Generate a live URL for the current page context
   * This method regenerates the live URL to ensure it points to the current active page
   */
  async generateLiveUrl(page: Page): Promise<string | null> {
    if (!page) {
      await dualLogError("Cannot generate live URL: no page available");
      return null;
    }

    try {
      const cdp = await page.createCDPSession();

      // Wait a bit before generating live URL
      await this.delay(2000);

      // Generate live URL for user interaction
      const liveUrlResponse = (await (cdp as any).send("Browserless.liveURL", {
        timeout: 600_000,
      })) as { liveURL: string };

      const liveURL = liveUrlResponse.liveURL;

      await dualLogInfo("Live URL generated successfully", {
        liveURL,
        currentPageUrl: page.url(),
      });

      return liveURL;
    } catch (error: any) {
      await dualLogError("Error generating live URL:", error, {
        platform: "booking",
        action: "generate_live_url",
        currentPageUrl: page.url(),
      });
      return null;
    }
  }

  private async createBrowserlessSession(): Promise<any> {
    try {
      await this.logInfo("Creating anonymous Browserless session (no email)");
      const session =
        await browserlessSessionService.createPersistentSession();
      await this.logInfo("Browserless session created successfully", {
        sessionId: session.id,
        browserWSEndpoint: session.connect,
      });
      return session;
    } catch (error) {
      await this.logError("Session creation failed", error);
      return null;
    }
  }
  private async solveCaptchaAutomatically(): Promise<boolean> {
    if (!this.page) return false;

    try {
      await this.logInfo("🚀 Starting advanced automatic captcha solution");

      // Use the new captcha service with multiple solving methods
      const result: CaptchaSolveResult = await this.captchaService.solveCaptcha(
        this.page,
        this.logInfo.bind(this)
      );

      if (result.success) {
        await this.logInfo(
          `✅ Captcha solved successfully using ${result.method} method`
        );

        // Log additional details if available
        if (result.analysis) {
          await this.logInfo("📊 Captcha analysis details", {
            type: result.analysis.captchaType,
            positionsFound: Array.isArray(result.analysis.positions)
              ? result.analysis.positions.length
              : 0,
            instruction: result.analysis.instruction,
          });
        }

        if (result.clickResult) {
          await this.logInfo(
            `🖱️ Click results: ${result.clickResult.successfulClicks}/${result.clickResult.totalElements} successful`
          );
        }

        return true;
      } else {
        // Check if no captcha was detected
        if (result.analysis?.captchaType === "no_captcha") {
          await this.logInfo(
            "🚫 No captcha detected on this page, continuing without captcha solving"
          );
          return true; // Return true since no captcha solving is needed
        }

        await this.logInfo(
          `❌ Advanced captcha solving failed with ${result.method} method`
        );
        if (result.error) {
          await this.logInfo(`Error details: ${result.error}`);
        }
        return false;
      }
    } catch (error) {
      await this.logError("Advanced automatic captcha solution failed", error);
      return false;
    }
  }

  /**
   * Check if CAPTCHA has been solved by monitoring page elements
   */
  private async checkCaptchaSolved(): Promise<boolean> {
    try {
      if (!this.page) {
        return false;
      }

      // Check if page is still attached/valid
      if (this.page.isClosed()) {
        await this.logInfo("Page is closed, CAPTCHA check cannot continue");
        return false;
      }

      // Check for password field (sign that login form is accessible)
      const passwordFieldExists = await this.page
        .$(
          'input[type="password"], input[name="password"], input[placeholder*="password" i]'
        )
        .catch(() => null);

      // Check if CAPTCHA elements are gone
      const pageContent = await this.page.content();
      const hasCaptcha = CAPTCHA_PATTERNS.some((pattern) =>
        pattern.test(pageContent)
      );

      // Check for successful navigation (away from CAPTCHA page)
      const currentUrl = this.page.url();
      const isOnLoginPage =
        currentUrl.includes("signin") ||
        currentUrl.includes("login") ||
        currentUrl.includes("account");

      if (
        passwordFieldExists ||
        !hasCaptcha ||
        (isOnLoginPage && !pageContent.includes("captcha"))
      ) {
        await this.logInfo(
          "CAPTCHA appears to be solved - password field detected or CAPTCHA elements removed"
        );
        return true;
      }

      return false;
    } catch (error) {
      await this.logError("Error checking CAPTCHA status:", error);
      return false;
    }
  }

  /**
   * Wait for CAPTCHA to be solved by user with polling
   */
  private async waitForCaptchaSolution(timeout: number): Promise<boolean> {
    return new Promise(async (resolve) => {
      const startTime = Date.now();
      const checkInterval = 2000; // Check every 2 seconds
      let consecutiveErrors = 0;
      const maxConsecutiveErrors = 3; // Stop after 3 consecutive errors

      const timer = setTimeout(() => {
        this.logError("Captcha timeout - user did not solve within time limit");
        resolve(false);
      }, timeout);

      const pollCaptchaStatus = async () => {
        try {
          const isSolved = await this.checkCaptchaSolved();
          consecutiveErrors = 0; // Reset error counter on success

          if (isSolved) {
            clearTimeout(timer);
            resolve(true);
            return;
          }

          // Continue checking if not timed out
          if (Date.now() - startTime < timeout) {
            setTimeout(pollCaptchaStatus, checkInterval);
          } else {
            clearTimeout(timer);
            resolve(false);
          }
        } catch (error) {
          consecutiveErrors++;
          await this.logError(
            `CAPTCHA polling error (${consecutiveErrors}/${maxConsecutiveErrors}):`,
            error
          );

          // Stop polling if too many consecutive errors
          if (consecutiveErrors >= maxConsecutiveErrors) {
            clearTimeout(timer);
            await this.logError(
              "Too many consecutive CAPTCHA polling errors, stopping"
            );
            resolve(false);
            return;
          }

          // Continue polling if not timed out and not too many errors
          if (Date.now() - startTime < timeout) {
            setTimeout(pollCaptchaStatus, checkInterval);
          } else {
            clearTimeout(timer);
            resolve(false);
          }
        }
      };

      // Start polling
      setTimeout(pollCaptchaStatus, checkInterval);
    });
  }

  private async solveCaptchaWithUI(
    sessionUrl: string,
    timeout: number
  ): Promise<boolean> {
    await this.logInfo("Manual captcha solving required");
    await this.logInfo(`Open this URL to solve captcha: ${sessionUrl}`);
    await this.logInfo(
      "System will automatically detect when CAPTCHA is solved"
    );

    // Send email notification about CAPTCHA
    await this.sendCaptchaEmail();

    // Wait for user to solve the CAPTCHA
    const solved = await this.waitForCaptchaSolution(timeout);

    if (!solved) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(
          BookingErrorType.CAPTCHA
        )}`,
        {
          errorType: BookingErrorType.CAPTCHA,
          error: new Error("CAPTCHA solving failed or timed out"),
          phase: BookingScrapingPhase.LOGIN,
          platform: "booking",
          action: "solve_captcha_with_ui",
        }
      );
    }

    return solved;
  }

  private async solveCaptchaManually(timeout: number): Promise<boolean> {
    await this.logInfo(
      "Manual captcha intervention required - waiting for user to solve"
    );

    // Send email notification about CAPTCHA
    await this.sendCaptchaEmail();

    // Wait for user to solve the CAPTCHA
    const solved = await this.waitForCaptchaSolution(timeout);

    if (!solved) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(
          BookingErrorType.CAPTCHA
        )}`,
        {
          errorType: BookingErrorType.CAPTCHA,
          error: new Error("Manual CAPTCHA solving failed or timed out"),
          phase: BookingScrapingPhase.LOGIN,
          platform: "booking",
          action: "solve_captcha_manually",
        }
      );
    }

    return solved;
  }


  private async sendCaptchaEmail(): Promise<void> {
    try {
      const captchaRecipientsFromEnv = process.env.CAPTCHA_RECIPIENTS
        ? process.env.CAPTCHA_RECIPIENTS.split(",").map((email) => email.trim())
        : [];
      const captchaRecipientsForMerge =
        captchaRecipientsFromEnv.length > 0
          ? captchaRecipientsFromEnv
          : [process.env.EMAIL_USER || "ITSUPPORT@vnpsolutions.com"];

      const errorMessage =
        "CAPTCHA detected during Booking.com login - Manual intervention required";

      const errorDetails = {
        sessionUrl: this.sessionUrl || "N/A",
        currentUrl: this.page?.url() || "Unknown",
        timestamp: new Date().toISOString(),
        instructions:
          "Please visit the session URL to solve the CAPTCHA. The system will automatically detect when solved",
        stage: "Login - CAPTCHA Challenge",
      };

      // Same path for all contexts (including trust): notifyJobError loads the job
      // and merges job.watcher_emails with captchaRecipients and EMAIL_USER.
      const jobIdForEmail =
        this.jobId && Types.ObjectId.isValid(this.jobId)
          ? this.jobId
          : "Unknown job";

      await emailNotifier.notifyJobError(
        jobIdForEmail,
        errorMessage,
        errorDetails,
        undefined,
        captchaRecipientsForMerge
      );
    } catch (error) {
      await this.logError("Failed to send CAPTCHA notification email:", error);
    }
  }

  /**
   * Submit captcha form after solution is injected
   */
  private async submitCaptchaForm(): Promise<void> {
    if (!this.page) return;

    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:contains("Submit")',
      'button:contains("Continue")',
      'button:contains("Verify")',
      'button:contains("Confirm")',
      ".captcha-submit",
      "#captcha-submit",
    ];

    for (const selector of submitSelectors) {
      try {
        if (selector.includes("contains")) {
          const found = await this.page.evaluate((text) => {
            const buttons = Array.from(document.querySelectorAll("button"));
            const button = buttons.find((btn) =>
              btn.textContent?.toLowerCase().includes(text.toLowerCase())
            );
            if (button) {
              (button as HTMLButtonElement).click();
              return true;
            }
            return false;
          }, selector.match(/contains\("(.+)"\)/)?.[1] || "");

          if (found) {
            await this.logInfo(`Clicked submit button: ${selector}`);
            break;
          }
        } else {
          const element = await this.page.$(selector);
          if (element) {
            await element.click();
            await this.logInfo(`Clicked submit button: ${selector}`);
            break;
          }
        }
      } catch (error) {
        // Continue to next selector
      }
    }
  }

  private async prompt2FA(timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      this.logInfo("Manual 2FA verification required");
      this.logInfo("Check support email for verification code");
      this.logInfo("Timeout: " + Math.floor(timeout / 1000) + " seconds");

      const timer = setTimeout(() => {
        rl.close();
        reject(
          new Error(
            "2FA timeout - no code entered within " +
              Math.floor(timeout / 1000) +
              " seconds"
          )
        );
      }, timeout);

      rl.question("Enter 2FA code (6 digits): ", (code) => {
        clearTimeout(timer);
        rl.close();

        if (!/^\d{6}$/.test(code.trim())) {
          console.log("Invalid code format. Please enter exactly 6 digits.");
          reject(new Error("Invalid 2FA code format"));
          return;
        }

        console.log("✅ Code accepted, submitting...");
        resolve(code.trim());
      });
    });
  }

  private async enterEmail(email: string): Promise<boolean> {
    // First, try to clear any existing value in email field
    for (const selector of BOOKING_SELECTORS.email) {
      try {
        const element = await this.page!.$(selector);
        if (element) {
          await this.logInfo(`Clearing email field with selector: ${selector}`);

          // Triple-click to select all and clear
          await element.click({ clickCount: 3 });
          await this.delay(200);
          await element.press("Backspace");
          await this.delay(200);

          await this.logInfo("Email field cleared, now entering new email");
          break;
        }
      } catch (error) {
        // Continue to next selector
        continue;
      }
    }

    return await SelectorUtils.findAndType(
      this.page!,
      [...BOOKING_SELECTORS.email],
      email
    );
  }

  private async enterPassword(password: string): Promise<boolean> {
    // First, try to clear any existing value in password field
    for (const selector of BOOKING_SELECTORS.password) {
      try {
        const element = await this.page!.$(selector);
        if (element) {
          await this.logInfo(
            `Clearing password field with selector: ${selector}`
          );

          // Triple-click to select all and clear
          await element.click({ clickCount: 3 });
          await this.delay(200);
          await element.press("Backspace");
          await this.delay(200);

          await this.logInfo(
            "Password field cleared, now entering new password"
          );
          break;
        }
      } catch (error) {
        // Continue to next selector
        continue;
      }
    }

    return await SelectorUtils.findAndType(
      this.page!,
      [...BOOKING_SELECTORS.password],
      password
    );
  }

  private async clickLoginButton(): Promise<boolean> {
    return await SelectorUtils.findAndClick(this.page!, [
      ...BOOKING_SELECTORS.loginButton,
    ]);
  }

  private async clickContinueButton(): Promise<boolean> {
    return await SelectorUtils.findAndClick(this.page!, [
      ...BOOKING_SELECTORS.continueButton,
    ]);
  }

  private async checkLoginErrors(): Promise<void> {
    try {
      // Wait for any error messages to appear
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Check for error messages
      const hasError = await SelectorUtils.trySelectors(
        this.page!,
        [...BOOKING_SELECTORS.errorMessages],
        async (selector: string) => {
          const element = await this.page!.$(selector);
          if (element) {
            const errorText = await element.evaluate((el) =>
              el.textContent?.trim()
            );
            if (errorText) {
              // Determine error type
              const errorType = this.determineLoginErrorType(errorText);
              const errorDescription = getBookingErrorDescription(errorType);
              const shouldRetry = shouldRetryBookingError(errorType);

              await dualLogError(
                `[${new Date().toISOString()}] ${errorDescription}`,
                {
                  errorType,
                  errorText,
                  shouldRetry,
                  phase: BookingScrapingPhase.LOGIN,
                  selector,
                  platform: "booking",
                }
              );

              await this.takeScreenshot();
              return true;
            }
          }
          return false;
        },
        5000 // 5 second timeout
      );

      if (hasError) {
        throw new Error("Login failed - error message detected");
      }

      await this.logInfo("Login error check passed - no errors detected");
    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(
          BookingErrorType.UNKNOWN
        )}`,
        {
          errorType: BookingErrorType.UNKNOWN,
          error: error,
          phase: BookingScrapingPhase.LOGIN,
          platform: "booking",
        }
      );
      throw error;
    }
  }

  // Method to determine error type from error text
  private determineLoginErrorType(errorText: string): BookingErrorType {
    const lowerErrorText = errorText.toLowerCase();

    // Authentication errors
    if (
      lowerErrorText.includes("don't match") ||
      lowerErrorText.includes("incorrect") ||
      lowerErrorText.includes("invalid credentials")
    ) {
      return BookingErrorType.AUTHENTICATION_ERROR;
    }

    // Account locked/blocked
    if (
      lowerErrorText.includes("locked") ||
      lowerErrorText.includes("blocked") ||
      lowerErrorText.includes("suspended")
    ) {
      return BookingErrorType.BLOCKED;
    }

    // Rate limiting
    if (
      lowerErrorText.includes("too many") ||
      lowerErrorText.includes("rate limit") ||
      lowerErrorText.includes("try again later")
    ) {
      return BookingErrorType.RATE_LIMITED;
    }

    // CAPTCHA
    if (
      lowerErrorText.includes("captcha") ||
      lowerErrorText.includes("verify") ||
      lowerErrorText.includes("robot")
    ) {
      return BookingErrorType.CAPTCHA;
    }

    // Network/connection issues
    if (
      lowerErrorText.includes("connection") ||
      lowerErrorText.includes("network") ||
      lowerErrorText.includes("timeout")
    ) {
      return BookingErrorType.NETWORK_ERROR;
    }

    // Default to login failed for other cases
    return BookingErrorType.LOGIN_FAILED;
  }

  /**
   * Check if scraping should be stopped based on context
   * TRUST_VERIFICATION context should not be stopped by general scraping state
   */
  private async checkScrapingShouldStop(
    action?: string,
    additionalData?: any
  ): Promise<boolean> {
    // If this is a trust verification context, don't stop the scraping
    if (this.context === ScraperContext.TRUST_VERIFICATION) {
      await dualLogInfo("Trust verification context detected");
      return false;
    }

    // For regular job context, check the scraping state
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogError(
        getBookingErrorDescription(BookingErrorType.SCRAPING_STOPPED),
        {
          errorType: BookingErrorType.SCRAPING_STOPPED,
          error: new Error(
            `Scraping was stopped during ${action || "operation"}`
          ),
          phase: BookingScrapingPhase.LOGIN,
          platform: "booking",
          action: action,
          ...additionalData,
        }
      );
      return true;
    }

    return false;
  }

  /**
   * Throw error if scraping should be stopped
   */
  private async throwIfScrapingShouldStop(
    action?: string,
    additionalData?: any
  ): Promise<void> {
    const shouldStop = await this.checkScrapingShouldStop(
      action,
      additionalData
    );
    if (shouldStop) {
      const stoppedErr = new Error(
        `Scraping was stopped during ${action || "operation"}`
      );
      setFailedReasonCode(stoppedErr, FAILED_REASON.BOOKING_SCRAPING_STOPPED);
      throw stoppedErr;
    }
  }
}
