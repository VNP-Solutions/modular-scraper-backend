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
import {
  ACCOUNT_LOCKED_SELECTORS,
  BOOKING_LOGIN_EXCLUDE_URLS,
  BOOKING_LOGIN_SUCCESS_URLS,
  BOOKING_SELECTORS,
  CAPTCHA_PATTERNS,
  PASSWORD_RECOVERY_SELECTORS,
  TWO_FA_PATTERNS,
  TWO_FA_TEXT_PATTERNS,
} from "../common/booking-selectors.js";
import { delay } from "../common/delay.js";
import { emailNotifier } from "../common/email-notifier.js";
import { decryptPassword } from "../common/encription.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { generateRandomPassword } from "../common/password-generator.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { SelectorUtils } from "../common/selector-utils.js";
import { timeoutManager } from "../common/timeout-manager.js";
import { Property } from "../models/property.model.js";
import handleBookingOtpVerification from "../otp-verification/booking-otp-verification.js";
import { getPasswordResetUrl } from "../otp-verification/email-verification-utils.js";
import {
  CaptchaService,
  CaptchaSolveResult,
} from "../services/captcha-service.js";
import { cookieStorageService } from "../services/cookie-storage.service.js";
import { propertyCredentialsService } from "../services/job-credentials.service.js";
import { jobService } from "../services/job.service.js";
import { propertyCredentialsService as propertyPasswordUpdateService } from "../services/property-credentials.service.js";
import { vccsManagementService } from "../services/vccs-management.service.js";
import {
  BaseScraper,
  CaptchaHandlerOptions,
  LoginCredentials,
  ScrapingJobParams,
  ScrapingResult,
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

  public setBrowserData(page: Page, browser: Browser): void {
    this.page = page;
    this.browser = browser;
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

  async setupBrowser(
    jobId?: string
  ): Promise<{ browser: Browser; page: Page }> {
    try {
      // Check environment - use local browser for local/development
      const environment = process.env.ENVIRONMENT || "browserless";
      if (environment === "local" || environment === "development") {
        await this.logInfo(
          "Environment set to local/development, using local browser"
        );
        return await this.setupLocalBrowser(jobId);
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

      // Create Browserless session for UI access
      const session = await this.createBrowserlessSession();
      if (session && session.id) {
        await this.logInfo("Browserless UI session created");
      } else {
        await this.logInfo(
          "Failed to create Browserless session, falling back to local browser"
        );
        // Fallback to local browser
        return await this.setupLocalBrowser(jobId);
      }

      // Connect to the created Browserless session
      const browser = await puppeteer.connect({
        browserWSEndpoint: session.connect,
        protocolTimeout: 300000,
        defaultViewport: null,
      });

      const page = await browser.newPage();
      await this.logInfo("Connected to Browserless session successfully");

      // Set viewport and timeouts
      // await page.setViewport({ width: 2560, height: 1440 });
      await page.setViewport({
        width: 1905,
        height: 945,
      });
      await page.setDefaultNavigationTimeout(loadingTimeout);
      await page.setDefaultTimeout(selectorTimeout);

      await this.generateLiveUrl(page);

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

      return { browser, page };
    } catch (error) {
      await this.logError("Browser setup failed", error);
      throw error;
    }
  }

  /**
   * Setup local browser for development/testing
   */
  private async setupLocalBrowser(
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

      // Set user agent to match your working curl exactly
      await page.setUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
      );

      // Set comprehensive headers to match your working curl exactly
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "max-age=0",
        "sec-ch-ua":
          '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        DNT: "1",
        "Upgrade-Insecure-Requests": "1",
      });

      // Hide automation indicators to avoid detection
      await page.evaluateOnNewDocument(() => {
        // Remove webdriver property
        delete (navigator as any).webdriver;

        // Override the plugins property to use a real value
        Object.defineProperty(navigator, "plugins", {
          get: () => [1, 2, 3, 4, 5],
        });

        // Override the languages property to use a real value
        Object.defineProperty(navigator, "languages", {
          get: () => ["en-US", "en"],
        });

        // Override chrome property
        (window as any).chrome = {
          runtime: {},
        };

        // Mock permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => {
          if (parameters.name === "notifications") {
            return Promise.resolve({
              state: Notification.permission,
              name: "notifications",
              onchange: null,
              addEventListener: () => {},
              removeEventListener: () => {},
              dispatchEvent: () => false,
            } as PermissionStatus);
          }
          return originalQuery(parameters);
        };

        // Override screen properties to match real browser
        Object.defineProperty(screen, "availWidth", {
          get: () => 1920,
        });
        Object.defineProperty(screen, "availHeight", {
          get: () => 1080,
        });
        Object.defineProperty(screen, "width", {
          get: () => 1920,
        });
        Object.defineProperty(screen, "height", {
          get: () => 1080,
        });
      });

      // Set default timeouts
      await page.setDefaultNavigationTimeout(loadingTimeout);
      await page.setDefaultTimeout(selectorTimeout);

      // Set viewport
      await page.setViewport({
        width: 1905,
        height: 945,
      });

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

    // Extract session parameters from URL
    await this.extractSessionParams();

    const cookies = await this.page.cookies();

    // Save cookies to storage if we have a property ID
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

    await this.takeScreenshot();

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

    // Skip property search if we have session parameters (will use direct navigation)
    if (this.sessionParams) {
      await this.logInfo(
        "Session parameters available - skipping property search (will use direct navigation)"
      );
    } else {
      await this.handlePropertySearch(effectivePropertyId);
    }
  }

  /**
   * Handle successful 2FA completion
   */
  private async handleSuccessful2FA(propertyId?: string): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");

    await this.logInfo("✅ 2FA completed successfully");

    // Extract session parameters from URL
    await this.extractSessionParams();

    const cookies = await this.page.cookies();

    // Save cookies to storage if we have a property ID
    if (this.propertyIdForDb) {
      const success = await cookieStorageService.saveCookies(
        this.propertyIdForDb,
        PlatformsType.BOOKING,
        cookies
      );
      if (!success) {
        await this.logWarn("Failed to save cookies after 2FA");
      }
    }

    await this.takeScreenshot();

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

    // Skip property search if we have session parameters (will use direct navigation)
    if (this.sessionParams) {
      await this.logInfo(
        "Session parameters available - skipping property search (will use direct navigation)"
      );
    } else {
      await this.handlePropertySearch(effectivePropertyId);
    }
  }

  /**
   * Check if user is already logged in
   */
  private isAlreadyLoggedIn(): boolean {
    if (!this.page) return false;

    const finalUrl = this.page.url();

    const isIncluded = BOOKING_LOGIN_SUCCESS_URLS.some((url) =>
      finalUrl.includes(url)
    );
    const isExcluded = BOOKING_LOGIN_EXCLUDE_URLS.some((url) =>
      finalUrl.includes(url)
    );

    return isIncluded && !isExcluded;
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

      const urlObj = new URL(currentUrl);
      const ses = urlObj.searchParams.get("ses");
      const lang = urlObj.searchParams.get("lang");

      if (ses && lang) {
        this.sessionParams = { ses, lang };
        await this.logInfo(
          `✅ Session parameters extracted - ses: ${ses}, lang: ${lang}`
        );
      } else {
        await this.logWarn(
          `Session parameters not found in URL. ses: ${ses}, lang: ${lang}`
        );
      }
    } catch (error) {
      await this.logError("Error extracting session parameters", error);
    }
  }

  /**
   * Navigate directly to VCCS management page using session parameters
   * This bypasses the need to click through menus
   *
   * @param hotelId - The booking.com hotel ID (property ID)
   * @returns Promise<boolean> - True if navigation successful
   */
  private async navigateDirectlyToVCCS(hotelId: string): Promise<boolean> {
    if (!this.page) {
      await this.logError("Page not initialized");
      return false;
    }

    if (!this.sessionParams) {
      await this.logWarn(
        "Session parameters not available, cannot use direct navigation"
      );
      return false;
    }

    try {
      const { ses, lang } = this.sessionParams;

      // Construct the direct VCCS management URL
      // Format: https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/vccs_management.html?lang=xu&hotel_id=10520417&ses=103bcbd7ad55834afa468b7fcf2c108c
      const vccsUrl = `https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/vccs_management.html?lang=${lang}&hotel_id=${hotelId}&ses=${ses}`;

      await this.logInfo(
        `🚀 Navigating directly to VCCS management: ${vccsUrl}`
      );

      // Navigate to the URL
      await this.page.goto(vccsUrl, {
        waitUntil: "networkidle2",
        timeout: 60000,
      });

      await this.delay(2000);
      await this.takeScreenshot();

      // Verify we're on the VCCS management page
      const currentUrl = this.page.url();
      if (
        currentUrl.includes("vccs_management") ||
        currentUrl.includes("vccs")
      ) {
        await this.logInfo("✅ Successfully navigated to VCCS management page");
        return true;
      } else {
        await this.logWarn(
          `Navigation may have failed. Current URL: ${currentUrl}`
        );
        return false;
      }
    } catch (error) {
      await this.logError("Error during direct VCCS navigation", error);
      return false;
    }
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
        await propertyPasswordUpdateService.getBookingCredentialsFromJob(
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

        // Extract session parameters from current URL
        await this.extractSessionParams();

        // Map MongoDB ObjectId (property _id) to actual Booking hotel id if needed
        let effectivePropertyId = propertyId;
        if (
          effectivePropertyId &&
          Types.ObjectId.isValid(effectivePropertyId)
        ) {
          try {
            const propertyRecord = await Property.findById(
              effectivePropertyId
            ).lean();
            if (propertyRecord && propertyRecord.booking_id) {
              this.setPropertyIdForDb(effectivePropertyId);
              effectivePropertyId = propertyRecord.booking_id.toString();
            }
          } catch (err) {
            await this.logError("Failed to map MongoDB id to booking id", err);
          }
        }

        // Skip property search if we have session parameters (will use direct navigation)
        if (this.sessionParams) {
          await this.logInfo(
            "Session parameters available - skipping property search (will use direct navigation)"
          );
        } else {
          await this.handlePropertySearch(effectivePropertyId);
        }
        return;
      }

      await this.logInfo("🔐 Starting login process");

      await this.handleCaptcha({
        sessionUrl: this.sessionUrl,
      });

      await this.logInfo("Entering email address");

      // Check if scraping should continue before entering email
      await this.throwIfScrapingShouldStop("enter_email");

      const emailEntered = await this.enterEmail(effectiveCredentials.email);
      if (!emailEntered) {
        await this.takeScreenshot();
        throw new Error("Email field not found");
      }

      await this.logInfo("Clicking Continue with email");
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

      // Check for account locked OR password mismatch (mutually exclusive)
      const accountWasLocked = await this.handleAccountLocked();

      if (accountWasLocked) {
        await this.logInfo("✅ Account unlocked - password reset completed");
        return; // Exit early, login retry already happened
      }

      // Only check password mismatch if account was NOT locked
      const passwordWasReset = await this.handlePasswordMismatch(
        loginCredentials.email
      );

      if (passwordWasReset) {
        await this.logInfo("✅ Password reset completed - login retry done");
        return; // Exit early, login retry already happened
      }

      // Only check for other login errors if neither account locked nor password mismatch
      await this.checkLoginErrors();

      // Handle successful login
      if (this.isAlreadyLoggedIn()) {
        await this.handleSuccessfulLogin(propertyId);
      } else {
        await this.logInfo("🔐 2FA required - starting verification");

        // Try to handle 2FA automatically
        const twoFASuccess = await this.handle2FA();
        if (twoFASuccess) {
          await this.handleSuccessful2FA(propertyId);
        } else {
          await dualLogError(
            getBookingErrorDescription(BookingErrorType.TWO_FA_ERROR),
            {
              errorType: BookingErrorType.TWO_FA_ERROR,
              phase: BookingScrapingPhase.LOGIN,
              platform: "booking",
            }
          );
          await this.takeScreenshot();
          throw new Error("2FA verification failed");
        }
      }
    } catch (error) {
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
        const { otpStatusManager } = await import(
          "../common/otp-status-manager.js"
        );
        await otpStatusManager.forceReleaseOtp();
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

        // Only try Browserless APIs if in Browserless environment
        const environment = process.env.ENVIRONMENT || "browserless";
        const isBrowserless =
          environment === "browserless" || environment === "production";

        if (isBrowserless) {
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
        } else {
          await this.logInfo(
            "Running in local mode - skipping Browserless recording/live URL for 2FA"
          );
        }

        await this.delay(300000);
        await this.logInfo("Manual 2FA timeout reached, continuing...");
        return true;
      }
    } catch (error) {
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
   * Check if account is locked and handle the unlock process
   * Returns true if account was locked and successfully unlocked, false if not locked
   */
  async handleAccountLocked(): Promise<boolean> {
    if (!this.page) return false;

    try {
      await this.logInfo("Checking for account locked page...");

      // Wait a bit for page to load
      await this.delay(3000);

      // Check page content for account locked patterns - MUST be SPECIFIC!
      const accountLockedPageContent = await this.page.content();

      // Check for MULTIPLE indicators - not just one!
      const hasAccountLockedHeading = /Account locked/i.test(
        accountLockedPageContent
      );
      const hasLockedForm = /nw-account-locked/.test(accountLockedPageContent);
      const hasLockedMessage = /we'?ve locked your.*booking\.com account/i.test(
        accountLockedPageContent
      );
      const hasUnlockButton = /Unlock with email/.test(
        accountLockedPageContent
      );

      // MUST have locked form AND (locked heading OR locked message) AND unlock button
      const isAccountLocked =
        hasLockedForm &&
        (hasAccountLockedHeading || hasLockedMessage) &&
        hasUnlockButton;

      await this.logInfo(
        `Account lock detection: form=${hasLockedForm}, heading=${hasAccountLockedHeading}, message=${hasLockedMessage}, button=${hasUnlockButton}, isLocked=${isAccountLocked}`
      );

      if (!isAccountLocked) {
        await this.logInfo("Account is not locked, continuing...");
        return false;
      }

      await this.logInfo(
        "Account locked page detected, starting unlock process..."
      );
      await this.takeScreenshot();

      // Check for CAPTCHA/2FA before looking for unlock button
      await this.logInfo("Checking for CAPTCHA/2FA before unlock button...");
      await this.handleCaptcha({ sessionUrl: this.sessionUrl });
      await this.delay(1000);

      // Step 1: Find and click "Unlock with email" button
      await this.logInfo("Looking for 'Unlock with email' button...");
      await this.delay(1000);

      let unlockButtonClicked = false;

      // Approach 1: Try with selectors first
      for (const selector of ACCOUNT_LOCKED_SELECTORS.unlockButton) {
        try {
          await this.logInfo(`Trying selector: ${selector}`);
          const element = await this.page.$(selector);

          if (element) {
            await this.logInfo(
              `Found unlock button with selector: ${selector}`
            );

            // Scroll into view
            await this.page.evaluate((el) => {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
            }, element);
            await this.delay(500);

            await this.logInfo(`Clicking 'Unlock with email' button...`);
            await element.click();
            unlockButtonClicked = true;
            await this.logInfo(
              "Successfully clicked 'Unlock with email' button"
            );
            break;
          }
        } catch (error) {
          await this.logInfo(`Selector ${selector} failed, trying next...`);
          continue;
        }
      }

      // Approach 2: Fallback - search by text content
      if (!unlockButtonClicked) {
        await this.logInfo("Trying text-based search for unlock button...");

        // Check for CAPTCHA/2FA again before text search
        await this.handleCaptcha({ sessionUrl: this.sessionUrl });
        await this.delay(500);

        unlockButtonClicked = await this.page.evaluate(() => {
          const buttons = Array.from(
            document.querySelectorAll('button[type="submit"], button')
          );
          for (const button of buttons) {
            const buttonText = button.textContent?.trim() || "";
            if (
              buttonText.includes("Unlock with email") ||
              buttonText.includes("Unlock")
            ) {
              (button as HTMLElement).scrollIntoView({
                behavior: "smooth",
                block: "center",
              });
              setTimeout(() => {
                (button as HTMLElement).click();
              }, 500);
              return true;
            }
          }
          return false;
        });

        if (unlockButtonClicked) {
          await this.delay(1000);
          await this.logInfo("Clicked via text search");
        }
      }

      if (!unlockButtonClicked) {
        // Maybe CAPTCHA/2FA appeared instead of unlock button
        await this.logInfo(
          "Unlock button not found, checking for CAPTCHA/2FA..."
        );
        await this.handleCaptcha({ sessionUrl: this.sessionUrl });

        // Check if we're on 2FA page
        const currentUrl = this.page.url();
        const pageContent = await this.page.content();
        const is2FAPage =
          TWO_FA_PATTERNS.some((pattern) => currentUrl.includes(pattern)) ||
          TWO_FA_TEXT_PATTERNS.some((pattern) => pageContent.includes(pattern));

        if (is2FAPage) {
          await this.logInfo(
            "2FA page detected instead of unlock button, handling 2FA..."
          );
          await this.handle2FA();
          // After 2FA, account might be unlocked, continue with flow
          return false; // Return false to indicate account wasn't locked, just 2FA
        }

        await this.logError(
          "Could not find or click 'Unlock with email' button"
        );
        await this.takeScreenshot();
        return false;
      }

      await this.delay(2000);
      await this.takeScreenshot();

      // Step 2: Check for captcha and handle it if present
      await this.logInfo(
        "Checking for captcha after clicking unlock button..."
      );
      await this.handleCaptcha({
        sessionUrl: this.sessionUrl,
      });

      await this.delay(3000);

      // Step 3: Wait for "Check your inbox" confirmation page
      await this.logInfo("Waiting for 'Check your inbox' confirmation...");
      const inboxConfirmationFound = await SelectorUtils.waitForSelector(
        this.page,
        ACCOUNT_LOCKED_SELECTORS.checkInboxHeader,
        30000
      );

      if (!inboxConfirmationFound) {
        await this.logError("Did not see 'Check your inbox' confirmation page");
        await this.takeScreenshot();
        return false;
      }

      await this.logInfo("'Check your inbox' confirmation page detected");
      await this.takeScreenshot();

      // Step 4: Get password reset URL from email
      await this.logInfo("Fetching password reset email...");
      const resetUrl = await getPasswordResetUrl(); // Waits 22-25s, then fetches latest 5 emails

      if (!resetUrl) {
        await this.logError("Could not get password reset URL from email");
        return false;
      }

      await this.logInfo(`Password reset URL retrieved: ${resetUrl}`);

      // Step 5: Open reset URL in new tab
      await this.logInfo("Opening password reset URL in new tab...");
      let resetPage;
      try {
        resetPage = await this.browser!.newPage();
        await this.logInfo(`Navigating to reset URL: ${resetUrl}`);
        await resetPage.goto(resetUrl, {
          waitUntil: "domcontentloaded", // More lenient than networkidle2
          timeout: 30000,
        });
        await this.delay(3000);
        await this.logInfo("Password reset page loaded successfully");
      } catch (error) {
        await this.logError("Error opening password reset page:", error);
        if (resetPage) {
          await resetPage.close();
        }
        return false;
      }

      // Step 6: Wait for password reset form
      await this.logInfo("Waiting for password reset form...");
      const formFound = await SelectorUtils.waitForSelector(
        resetPage,
        ACCOUNT_LOCKED_SELECTORS.passwordResetForm,
        30000
      );

      if (!formFound) {
        await this.logError("Password reset form not found");
        await resetPage.close();
        return false;
      }

      await this.logInfo("Password reset form loaded");
      await this.delay(2000);

      // Step 7: Generate random password
      const newPassword = generateRandomPassword(12);
      await this.logInfo("Generated new random password");

      // Step 7.5: Update password in database if jobId is available
      if (this.jobId) {
        await this.logInfo(
          "Updating booking password in database for all properties with same username (job " +
            this.jobId +
            ")"
        );
        const updateResult =
          await propertyPasswordUpdateService.updateBookingPasswordByJobId(
            this.jobId,
            newPassword
          );

        if (updateResult.success) {
          await this.logInfo(
            `Booking password updated successfully for ${updateResult.totalUpdated} properties in database`
          );
          await this.logInfo(
            `Affected properties: ${updateResult.affectedProperties
              .map((p) => p.propertyName)
              .join(", ")}`
          );

          // Send password change notification email with all affected properties
          await this.sendPasswordChangeEmail(
            newPassword,
            "Account was locked - password reset required",
            updateResult
          );
        } else {
          await this.logError(
            "Failed to update booking password in database, but continuing with reset"
          );
        }
      } else {
        await this.logInfo(
          "No jobId available, skipping password database update"
        );
      }

      // Step 8: Enter new password
      await this.logInfo("Entering new password...");
      const newPasswordEntered = await SelectorUtils.findAndType(
        resetPage,
        ACCOUNT_LOCKED_SELECTORS.newPasswordInput,
        newPassword
      );

      if (!newPasswordEntered) {
        await this.logError("Could not enter new password");
        await resetPage.close();
        return false;
      }

      await this.delay(1000);

      // Step 9: Confirm password
      await this.logInfo("Confirming password...");
      const confirmPasswordEntered = await SelectorUtils.findAndType(
        resetPage,
        ACCOUNT_LOCKED_SELECTORS.confirmPasswordInput,
        newPassword
      );

      if (!confirmPasswordEntered) {
        await this.logError("Could not confirm password");
        await resetPage.close();
        return false;
      }

      await this.delay(2000);

      // Step 10: Click "Set new password" button
      await this.logInfo("Clicking 'Set new password' button...");
      const passwordSet = await SelectorUtils.findAndClick(
        resetPage,
        ACCOUNT_LOCKED_SELECTORS.setPasswordButton
      );

      if (!passwordSet) {
        await this.logError("Could not click 'Set new password' button");
        await resetPage.close();
        return false;
      }

      await this.logInfo("Clicked 'Set new password' button");
      await this.delay(3000);

      // Step 11: Close the reset tab
      await this.logInfo("Closing password reset tab...");
      await resetPage.close();

      await this.logInfo("Account unlock process completed successfully");
      await this.takeScreenshot();

      // Step 12: Navigate back to sign-in page if we're still on the "Check your inbox" page
      await this.delay(2000);
      const currentUrl = this.page.url();
      const inboxPageContent = await this.page.content();

      if (
        inboxPageContent.includes("Check your inbox") ||
        currentUrl.includes("account-recovery")
      ) {
        await this.logInfo("Navigating back to sign-in page...");

        // Try to click "Back to sign-in" link if it exists
        const backToSignInClicked = await this.page
          .evaluate(() => {
            const links = Array.from(
              document.querySelectorAll('a.nw-link-signin, a[href*="sign-in"]')
            );
            for (const link of links) {
              const linkText = link.textContent?.trim() || "";
              if (
                linkText.includes("Back to sign-in") ||
                linkText.includes("sign-in")
              ) {
                (link as HTMLElement).click();
                return true;
              }
            }
            return false;
          })
          .catch(() => false);

        if (!backToSignInClicked) {
          // If no link found, navigate directly to sign-in page
          await this.page.goto("https://admin.booking.com/sign-in", {
            waitUntil: "networkidle2",
            timeout: 30000,
          });
        }

        await this.delay(3000);
        await this.takeScreenshot();
      }

      // Wait for sign-in page to load properly
      await this.delay(3000);

      // Step 13: Fetch new credentials from database and retry login
      await this.logInfo(
        "Password reset completed, fetching new credentials from database..."
      );

      if (!this.jobId) {
        await this.logError(
          "No jobId available, cannot fetch new credentials for retry"
        );
        return true; // Password was reset, but can't auto-retry
      }

      const newCredentials =
        await propertyCredentialsService.getBookingCredentialsFromJob(
          this.jobId
        );

      if (!newCredentials || !newCredentials.bookingPassword) {
        await this.logError(
          "Could not fetch new credentials from database for retry"
        );
        return true; // Password was reset, but can't auto-retry
      }

      // Decrypt the new password
      const decryptedPassword = decryptPassword(newCredentials.bookingPassword);
      await this.logInfo("New credentials fetched and decrypted successfully");

      // Step 14: Retry login with new credentials using existing login method
      await this.logInfo(
        "Retrying login with new password using login method..."
      );

      await this.login(
        {
          email: newCredentials.bookingUsername || "",
          password: decryptedPassword,
        },
        newCredentials.propertyId,
        true // skipAlreadyLogged = true to force re-login
      );

      await this.logInfo(
        "Login retry completed with new password, continuing main flow..."
      );

      return true;
    } catch (error) {
      await this.logError("Error handling account locked:", error);
      await this.takeScreenshot();
      return false;
    }
  }

  /**
   * Handle password mismatch error by resetting password
   * Returns true if password was reset, false if no error detected
   */
  async handlePasswordMismatch(username: string): Promise<boolean> {
    if (!this.page) return false;

    try {
      await this.logInfo("Checking for password mismatch error...");

      // Wait a bit for error message to appear
      await this.delay(2000);

      // Check page content for password mismatch patterns - MUST be SPECIFIC!
      const passwordErrorPageContent = await this.page.content();
      const currentUrl = this.page.url();

      // Check for specific error messages - be VERY specific!
      const hasUsernamePasswordMismatch =
        /username and password.*don't match/i.test(passwordErrorPageContent) ||
        /username and password entered don't match/i.test(
          passwordErrorPageContent
        );
      const hasIncorrectPassword = /password.*incorrect/i.test(
        passwordErrorPageContent
      );
      const hasInvalidCredentials = /invalid.*credentials/i.test(
        passwordErrorPageContent
      );
      const hasAccountLockWarning =
        /after \d+ attempts.*account will be locked/i.test(
          passwordErrorPageContent
        );

      // Check for error-block class (Booking.com uses this for actual errors)
      const hasErrorBlock = /<span class="error-block">/i.test(
        passwordErrorPageContent
      );

      // Check if on sign-in page
      const isOnSignInPage =
        currentUrl.includes("sign-in") || currentUrl.includes("login");

      // Check if forgot password button exists
      const hasForgotPasswordButton = /Forgot your password\?/.test(
        passwordErrorPageContent
      );

      // Exclude ONLY informational messages (not actual errors)
      // "password was recently updated" is informational, BUT if it appears with error-block, it might be part of error context
      const isJustInformational =
        /password was recently updated/i.test(passwordErrorPageContent) &&
        !hasUsernamePasswordMismatch &&
        !hasIncorrectPassword &&
        !hasInvalidCredentials &&
        !hasAccountLockWarning &&
        !hasErrorBlock;

      // MUST have actual error message AND be on sign-in page AND have forgot password button
      // AND NOT just be an informational message
      const hasPasswordError =
        (hasUsernamePasswordMismatch ||
          hasIncorrectPassword ||
          hasInvalidCredentials ||
          hasAccountLockWarning ||
          hasErrorBlock) &&
        isOnSignInPage &&
        hasForgotPasswordButton &&
        !isJustInformational;

      await this.logInfo(
        `Password mismatch detection: mismatch=${hasUsernamePasswordMismatch}, incorrect=${hasIncorrectPassword}, invalid=${hasInvalidCredentials}, warning=${hasAccountLockWarning}, errorBlock=${hasErrorBlock}, signInPage=${isOnSignInPage}, forgotButton=${hasForgotPasswordButton}, justInformational=${isJustInformational}, hasError=${hasPasswordError}`
      );

      if (!hasPasswordError) {
        await this.logInfo(
          "No password mismatch error detected, continuing..."
        );
        return false;
      }

      await this.logInfo(
        "Password mismatch error detected, starting password reset flow..."
      );
      await this.takeScreenshot();

      // Check for CAPTCHA/2FA before looking for forgot password button
      await this.logInfo(
        "Checking for CAPTCHA/2FA before forgot password button..."
      );
      await this.handleCaptcha({ sessionUrl: this.sessionUrl });
      await this.delay(1000);

      // Step 1: Find and click "Forgot your password?" button
      await this.logInfo("Looking for 'Forgot your password?' button...");
      await this.delay(1000);

      // Try multiple approaches to click the button
      let forgotPasswordClicked = false;

      // Approach 1: Try with selectors using SelectorUtils (most reliable)
      for (const selector of PASSWORD_RECOVERY_SELECTORS.forgotPasswordButton) {
        try {
          await this.logInfo(`Trying selector: ${selector}`);
          const element = await this.page.$(selector);

          if (element) {
            await this.logInfo(`Found button with selector: ${selector}`);

            // Scroll into view
            await this.page.evaluate((el) => {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
            }, element);
            await this.delay(500);

            await this.logInfo(`Clicking 'Forgot your password?' button...`);
            await element.click();
            forgotPasswordClicked = true;
            await this.logInfo(
              "Successfully clicked 'Forgot your password?' button"
            );
            break;
          }
        } catch (error) {
          await this.logInfo(`Selector ${selector} failed, trying next...`);
          continue;
        }
      }

      // Approach 2: Fallback - search by text content
      if (!forgotPasswordClicked) {
        await this.logInfo("Trying text-based search as fallback...");

        // Check for CAPTCHA/2FA again before text search
        await this.handleCaptcha({ sessionUrl: this.sessionUrl });
        await this.delay(500);

        forgotPasswordClicked = await this.page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll("button"));
          for (const button of buttons) {
            const buttonText = button.textContent?.trim() || "";
            if (buttonText.includes("Forgot your password")) {
              (button as HTMLElement).scrollIntoView({
                behavior: "smooth",
                block: "center",
              });
              setTimeout(() => {
                (button as HTMLElement).click();
              }, 500);
              return true;
            }
          }
          return false;
        });

        if (forgotPasswordClicked) {
          await this.delay(1000);
          await this.logInfo("Clicked via text search");
        }
      }

      if (!forgotPasswordClicked) {
        // Maybe CAPTCHA/2FA appeared instead of forgot password button
        await this.logInfo(
          "Forgot password button not found, checking for CAPTCHA/2FA..."
        );
        await this.handleCaptcha({ sessionUrl: this.sessionUrl });

        // Check if we're on 2FA page
        const currentUrl = this.page.url();
        const pageContent = await this.page.content();
        const is2FAPage =
          TWO_FA_PATTERNS.some((pattern) => currentUrl.includes(pattern)) ||
          TWO_FA_TEXT_PATTERNS.some((pattern) => pageContent.includes(pattern));

        if (is2FAPage) {
          await this.logInfo(
            "2FA page detected instead of forgot password button, handling 2FA..."
          );
          await this.handle2FA();
          // After 2FA, continue with normal flow
          return false; // Return false to indicate password wasn't mismatched, just 2FA
        }

        await this.logError(
          "Could not find or click 'Forgot your password?' button"
        );
        await this.takeScreenshot();
        return false;
      }

      await this.delay(2000);
      await this.takeScreenshot();

      // Step 2: Check for captcha and handle it if present
      await this.logInfo(
        "Checking for captcha after clicking forgot password button..."
      );
      await this.handleCaptcha({
        sessionUrl: this.sessionUrl,
      });

      await this.delay(3000);

      // Step 3: Wait for username recovery form
      await this.logInfo("Waiting for username recovery form...");
      const formFound = await SelectorUtils.waitForSelector(
        this.page,
        PASSWORD_RECOVERY_SELECTORS.usernameRecoveryForm,
        30000
      );

      if (!formFound) {
        await this.logError("Username recovery form not found");
        await this.takeScreenshot();
        return false;
      }

      await this.logInfo(
        "Username recovery form loaded (username is pre-filled)"
      );
      await this.takeScreenshot();

      // Username is already pre-filled in the input field, no need to enter it
      await this.delay(2000);
      await this.takeScreenshot();

      // Check for CAPTCHA/2FA before looking for send reset link button
      await this.logInfo(
        "Checking for CAPTCHA/2FA before send reset link button..."
      );
      await this.handleCaptcha({ sessionUrl: this.sessionUrl });
      await this.delay(1000);

      // Step 3: Click "Send reset link" button
      await this.logInfo("Looking for 'Send reset link' button...");
      await this.delay(1000);

      let sendResetClicked = false;

      // Approach 1: Try with selectors first
      for (const selector of PASSWORD_RECOVERY_SELECTORS.sendResetLinkButton) {
        try {
          await this.logInfo(`Trying selector: ${selector}`);
          const element = await this.page.$(selector);

          if (element) {
            await this.logInfo(
              `Found 'Send reset link' button with selector: ${selector}`
            );

            // Scroll into view
            await this.page.evaluate((el) => {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
            }, element);
            await this.delay(500);

            await this.logInfo(`Clicking 'Send reset link' button...`);
            await element.click();
            sendResetClicked = true;
            await this.logInfo("Successfully clicked 'Send reset link' button");
            break;
          }
        } catch (error) {
          await this.logInfo(`Selector ${selector} failed, trying next...`);
          continue;
        }
      }

      // Approach 2: Fallback - search by text content
      if (!sendResetClicked) {
        await this.logInfo("Trying text-based search for 'Send reset link'...");

        // Check for CAPTCHA/2FA again before text search
        await this.handleCaptcha({ sessionUrl: this.sessionUrl });
        await this.delay(500);

        sendResetClicked = await this.page.evaluate(() => {
          const buttons = Array.from(
            document.querySelectorAll('button[type="submit"], button')
          );
          for (const button of buttons) {
            const buttonText = button.textContent?.trim() || "";
            if (
              buttonText.includes("Send reset link") ||
              buttonText.includes("send reset link")
            ) {
              (button as HTMLElement).scrollIntoView({
                behavior: "smooth",
                block: "center",
              });
              setTimeout(() => {
                (button as HTMLElement).click();
              }, 500);
              return true;
            }
          }
          return false;
        });

        if (sendResetClicked) {
          await this.delay(1000);
          await this.logInfo("Clicked via text search");
        }
      }

      if (!sendResetClicked) {
        // Maybe CAPTCHA/2FA appeared instead of send reset link button
        await this.logInfo(
          "Send reset link button not found, checking for CAPTCHA/2FA..."
        );
        await this.handleCaptcha({ sessionUrl: this.sessionUrl });

        // Check if we're on 2FA page
        const currentUrl = this.page.url();
        const pageContent = await this.page.content();
        const is2FAPage =
          TWO_FA_PATTERNS.some((pattern) => currentUrl.includes(pattern)) ||
          TWO_FA_TEXT_PATTERNS.some((pattern) => pageContent.includes(pattern));

        if (is2FAPage) {
          await this.logInfo(
            "2FA page detected instead of send reset link button, handling 2FA..."
          );
          await this.handle2FA();
          // After 2FA, might need to retry the recovery process
          return false;
        }

        await this.logError("Could not find or click 'Send reset link' button");
        await this.takeScreenshot();
        return false;
      }

      await this.delay(2000);
      await this.takeScreenshot();

      // Step 5: Check for captcha and handle it if present
      await this.logInfo(
        "Checking for captcha after clicking send reset link button..."
      );
      await this.handleCaptcha({
        sessionUrl: this.sessionUrl,
      });

      await this.delay(3000);

      // Step 6: Wait for "Check your inbox" confirmation page
      await this.logInfo("Waiting for 'Check your inbox' confirmation...");
      const inboxConfirmationFound = await SelectorUtils.waitForSelector(
        this.page,
        ACCOUNT_LOCKED_SELECTORS.checkInboxHeader,
        30000
      );

      if (!inboxConfirmationFound) {
        await this.logError("Did not see 'Check your inbox' confirmation page");
        await this.takeScreenshot();
        return false;
      }

      await this.logInfo("'Check your inbox' confirmation page detected");
      await this.takeScreenshot();

      // Step 6: Get password reset URL from email
      await this.logInfo("Fetching password reset email...");
      const resetUrl = await getPasswordResetUrl(); // Waits 22-25s, then fetches latest 5 emails

      if (!resetUrl) {
        await this.logError("Could not get password reset URL from email");
        return false;
      }

      await this.logInfo(`Password reset URL retrieved: ${resetUrl}`);

      // Step 7: Open reset URL in new tab
      await this.logInfo("Opening password reset URL in new tab...");
      let resetPage;
      try {
        resetPage = await this.browser!.newPage();
        await this.logInfo(`Navigating to reset URL: ${resetUrl}`);
        await resetPage.goto(resetUrl, {
          waitUntil: "domcontentloaded", // More lenient than networkidle2
          timeout: 30000,
        });
        await this.delay(3000);
        await this.logInfo("Password reset page loaded successfully");
      } catch (error) {
        await this.logError("Error opening password reset page:", error);
        if (resetPage) {
          await resetPage.close();
        }
        return false;
      }

      // Step 8: Wait for password reset form
      await this.logInfo("Waiting for password reset form...");
      const resetFormFound = await SelectorUtils.waitForSelector(
        resetPage,
        ACCOUNT_LOCKED_SELECTORS.passwordResetForm,
        30000
      );

      if (!resetFormFound) {
        await this.logError("Password reset form not found");
        await resetPage.close();
        return false;
      }

      await this.logInfo("Password reset form loaded");
      await this.delay(2000);

      // Step 9: Generate random password
      const newPassword = generateRandomPassword(12);
      await this.logInfo("Generated new random password");

      // Step 9.5: Update password in database if jobId is available
      if (this.jobId) {
        await this.logInfo(
          "Updating booking password in database for all properties with same username (job " +
            this.jobId +
            ")"
        );
        const updateResult =
          await propertyPasswordUpdateService.updateBookingPasswordByJobId(
            this.jobId,
            newPassword
          );

        if (updateResult.success) {
          await this.logInfo(
            `Booking password updated successfully for ${updateResult.totalUpdated} properties in database`
          );
          await this.logInfo(
            `Affected properties: ${updateResult.affectedProperties
              .map((p) => p.propertyName)
              .join(", ")}`
          );

          // Send password change notification email with all affected properties
          await this.sendPasswordChangeEmail(
            newPassword,
            "Password mismatch detected - password reset required",
            updateResult
          );
        } else {
          await this.logError(
            "Failed to update booking password in database, but continuing with reset"
          );
        }
      } else {
        await this.logInfo(
          "No jobId available, skipping password database update"
        );
      }

      // Step 10: Enter new password
      await this.logInfo("Entering new password...");
      const newPasswordEntered = await SelectorUtils.findAndType(
        resetPage,
        ACCOUNT_LOCKED_SELECTORS.newPasswordInput,
        newPassword
      );

      if (!newPasswordEntered) {
        await this.logError("Could not enter new password");
        await resetPage.close();
        return false;
      }

      await this.delay(1000);

      // Step 11: Confirm password
      await this.logInfo("Confirming password...");
      const confirmPasswordEntered = await SelectorUtils.findAndType(
        resetPage,
        ACCOUNT_LOCKED_SELECTORS.confirmPasswordInput,
        newPassword
      );

      if (!confirmPasswordEntered) {
        await this.logError("Could not confirm password");
        await resetPage.close();
        return false;
      }

      await this.delay(2000);

      // Step 12: Click "Set new password" button
      await this.logInfo("Clicking 'Set new password' button...");
      const passwordSet = await SelectorUtils.findAndClick(
        resetPage,
        ACCOUNT_LOCKED_SELECTORS.setPasswordButton
      );

      if (!passwordSet) {
        await this.logError("Could not click 'Set new password' button");
        await resetPage.close();
        return false;
      }

      await this.logInfo("Clicked 'Set new password' button");
      await this.delay(3000);

      // Step 13: Close the reset tab
      await this.logInfo("Closing password reset tab...");
      await resetPage.close();

      await this.logInfo("Password reset process completed successfully");
      await this.takeScreenshot();

      // Step 14: Navigate back to sign-in page if needed
      await this.delay(2000);
      const pageUrl = this.page.url();
      const recoveryPageContent = await this.page.content();

      if (
        recoveryPageContent.includes("Check your inbox") ||
        pageUrl.includes("account-recovery")
      ) {
        await this.logInfo("Navigating back to sign-in page...");

        // Try to click "Back to sign-in" link if it exists
        const backToSignInClicked = await this.page
          .evaluate(() => {
            const links = Array.from(
              document.querySelectorAll('a.nw-link-signin, a[href*="sign-in"]')
            );
            for (const link of links) {
              const linkText = link.textContent?.trim() || "";
              if (
                linkText.includes("Back to sign-in") ||
                linkText.includes("sign-in")
              ) {
                (link as HTMLElement).click();
                return true;
              }
            }
            return false;
          })
          .catch(() => false);

        if (!backToSignInClicked) {
          // If no link found, navigate directly to sign-in page
          await this.page.goto("https://admin.booking.com/sign-in", {
            waitUntil: "networkidle2",
            timeout: 30000,
          });
        }

        await this.delay(3000);
        await this.takeScreenshot();
      }

      // Wait for sign-in page to load properly
      await this.delay(3000);

      // Step 15: Fetch new credentials from database and retry login
      await this.logInfo(
        "Password reset completed, fetching new credentials from database..."
      );

      if (!this.jobId) {
        await this.logError(
          "No jobId available, cannot fetch new credentials for retry"
        );
        return true; // Password was reset, but can't auto-retry
      }

      const newCredentials =
        await propertyCredentialsService.getBookingCredentialsFromJob(
          this.jobId
        );

      if (!newCredentials || !newCredentials.bookingPassword) {
        await this.logError(
          "Could not fetch new credentials from database for retry"
        );
        return true; // Password was reset, but can't auto-retry
      }

      // Decrypt the new password
      const decryptedPassword = decryptPassword(newCredentials.bookingPassword);
      await this.logInfo("New credentials fetched and decrypted successfully");

      // Step 16: Retry login with new credentials using existing login method
      await this.logInfo(
        "Retrying login with new password using login method..."
      );

      await this.login(
        {
          email: newCredentials.bookingUsername || "",
          password: decryptedPassword,
        },
        newCredentials.propertyId,
        true // skipAlreadyLogged = true to force re-login
      );

      await this.logInfo(
        "Login retry completed with new password, continuing main flow..."
      );

      return true;
    } catch (error) {
      await this.logError("Error handling password mismatch:", error);
      await this.takeScreenshot();
      return false;
    }
  }

  async clickViewAllVccsToCharge(): Promise<boolean> {
    // Check if scraping should continue before clicking view all
    await this.throwIfScrapingShouldStop("click_view_all_vccs_to_charge");

    return await SelectorUtils.findAndClick(this.page!, [
      BOOKING_SELECTORS.vccs.vccsToChargeLink,
    ]);
  }

  async getPaginationInfo(): Promise<{
    currentPage: number;
    totalPages: number;
  } | null> {
    if (!this.page) throw new Error("Page not initialized");

    try {
      const currentPageElement = await this.page.$(
        BOOKING_SELECTORS.pagination.currentPageIndicator
      );
      const totalPagesElement = await this.page.$(
        BOOKING_SELECTORS.pagination.totalPagesIndicator
      );

      if (currentPageElement && totalPagesElement) {
        const currentPage = await currentPageElement.evaluate((el) =>
          parseInt(el.textContent?.trim() || "1")
        );
        const totalPages = await totalPagesElement.evaluate((el) =>
          parseInt(el.textContent?.trim() || "1")
        );

        await this.logInfo(
          `Pagination info: Current page ${currentPage} of ${totalPages}`
        );
        return { currentPage, totalPages };
      }

      return null;
    } catch (error) {
      await this.logInfo(
        `No pagination found or error reading pagination info: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
      return null;
    }
  }

  async goToNextPage(): Promise<boolean> {
    return await SelectorUtils.findAndClick(this.page!, [
      BOOKING_SELECTORS.pagination.nextPageButton,
    ]);
  }

  async goToPreviousPage(): Promise<boolean> {
    return await SelectorUtils.findAndClick(this.page!, [
      BOOKING_SELECTORS.pagination.previousPageButton,
    ]);
  }

  async goToPage(pageNumber: number): Promise<boolean> {
    if (!this.page) throw new Error("Page not initialized");

    try {
      await this.logInfo(`Attempting to navigate to page ${pageNumber}`);

      // Try to find and click the specific page number
      const pageSelector = `${BOOKING_SELECTORS.pagination.pageNumbers}[data-page="${pageNumber}"]`;
      const pageElement = await this.page.$(pageSelector);

      if (pageElement) {
        await pageElement.click();
        await this.page.waitForNavigation({
          waitUntil: "networkidle2",
          timeout: 10000,
        });
        await this.logInfo(`Successfully navigated to page ${pageNumber}`);
        return true;
      }

      await this.logInfo(
        `Page ${pageNumber} not found, using next/previous navigation`
      );
      return false;
    } catch (error) {
      await this.logInfo(
        `Error navigating to page ${pageNumber}: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
      return false;
    }
  }

  async getReservationRows(): Promise<string[]> {
    if (!this.page) throw new Error("Page not initialized");

    try {
      // Check if scraping should continue before getting reservation rows
      await this.throwIfScrapingShouldStop("get_reservation_rows");

      await this.logInfo("Getting reservation rows from current page...");

      // Wait for the table to load
      await this.page.waitForSelector(
        BOOKING_SELECTORS.reservations.reservationRow,
        { timeout: 10000 }
      );

      // Get all reservation IDs from the current page
      const reservationIds = await this.page.evaluate((selectors) => {
        const rows = document.querySelectorAll(selectors.reservationRow);
        const ids: any[] = [];

        rows.forEach((row) => {
          const rowData: any = {};
          const idElement = row.querySelector(selectors.reservationId);
          if (idElement) {
            const href = idElement.getAttribute("href");
            if (href) {
              // Extract reservation ID from href
              const match = href.match(/res_id=(\d+)/);
              if (match) {
                rowData.id = match[1];
              }
            }
          }
          const amountElement = row.querySelector(selectors.reservationAmount);
          if (amountElement) {
            const amount = amountElement.textContent?.trim();
            if (amount) {
              rowData.amount = amount;
            }
          }
          const chargeBeforeElement = row.querySelector(
            selectors.reservationChargeBefore
          );
          if (chargeBeforeElement) {
            const chargeBefore = chargeBeforeElement.textContent?.trim();
            if (chargeBefore) {
              rowData.chargeBefore = chargeBefore;
            }
          }
          ids.push(rowData);
        });

        return ids;
      }, BOOKING_SELECTORS.reservations);

      await this.logInfo(
        `Found ${reservationIds.length} reservations on current page`
      );
      return reservationIds;
    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(
          BookingErrorType.DOM_NOT_FOUND
        )}`,
        {
          errorType: BookingErrorType.DOM_NOT_FOUND,
          error: error,
          phase: BookingScrapingPhase.NAVIGATION,
          platform: "booking",
          action: "get_reservation_rows",
          selector: BOOKING_SELECTORS.reservations.reservationRow,
        }
      );
      return [];
    }
  }

  async getReservationData(): Promise<
    Array<{
      id: string;
      chargeBefore: string;
      amount: string;
      cardholder: string;
    }>
  > {
    if (!this.page) throw new Error("Page not initialized");

    try {
      await this.logInfo("Extracting reservation data from current page...");

      const reservationData = await this.page.evaluate(() => {
        const rows = document.querySelectorAll(
          BOOKING_SELECTORS.reservations.reservationRow
        );
        const data: Array<{
          id: string;
          chargeBefore: string;
          amount: string;
          cardholder: string;
        }> = [];

        rows.forEach((row) => {
          const idElement = row.querySelector(
            BOOKING_SELECTORS.reservations.reservationId
          );
          const chargeBeforeElement = row.querySelector(
            BOOKING_SELECTORS.reservations.reservationChargeBefore
          );
          const amountElement = row.querySelector(
            BOOKING_SELECTORS.reservations.reservationAmount
          );
          const cardholderElement = row.querySelector(
            BOOKING_SELECTORS.reservations.reservationCardholder
          );

          if (idElement) {
            const href = idElement.getAttribute("href");
            if (href) {
              const match = href.match(/res_id=(\d+)/);
              if (match) {
                data.push({
                  id: match[1],
                  chargeBefore: chargeBeforeElement?.textContent?.trim() || "",
                  amount: amountElement?.textContent?.trim() || "",
                  cardholder: cardholderElement?.textContent?.trim() || "",
                });
              }
            }
          }
        });

        return data;
      });

      await this.logInfo(
        `Extracted data for ${reservationData.length} reservations`
      );
      return reservationData;
    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(
          BookingErrorType.DOM_NOT_FOUND
        )}`,
        {
          errorType: BookingErrorType.DOM_NOT_FOUND,
          error: error,
          phase: BookingScrapingPhase.NAVIGATION,
          platform: "booking",
          action: "get_reservation_data",
        }
      );
      return [];
    }
  }

  async clickReservationDetail(
    reservation: any,
    jobId?: string,
    propertyId?: string
  ): Promise<boolean> {
    if (!this.page) throw new Error("Page not initialized");

    try {
      // Check if scraping should continue before clicking reservation detail
      await this.throwIfScrapingShouldStop("click_reservation_detail", {
        reservationId: reservation.id,
      });

      await this.logInfo(
        `Attempting to open reservation detail for ID: ${reservation.id}`
      );

      // Listen for new page creation for reservation view
      const newPagePromise = new Promise<Page>((resolve) => {
        this.browser!.once("targetcreated", async (target) => {
          if (target.type() === "page") {
            const newPage = await target.page();
            await newPage!.bringToFront();

            resolve(newPage!);
          }
        });
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("Timeout waiting for new tab to open")),
          120000
        );
      });

      // Click the reservation link
      await this.logInfo(`Click the reservation link`);
      await SelectorUtils.findAndClick(
        this.page,
        BOOKING_SELECTORS.reservations.item(reservation.id)
      );

      await this.logInfo(`Waiting for new tab loading`);

      let newPage = null;

      try {
        newPage = await Promise.race([newPagePromise, timeoutPromise]);
        this.page = newPage;
      } catch (error) {
        await this.logError("Timeout waiting for new tab to open:", error);
        return false;
      }

      await this.logInfo(`New tab loaded`);

      // Check on captcha
      let captchaHandled = await this.handleCaptcha({
        sessionUrl: this.sessionUrl,
        page: newPage,
      });

      if (!captchaHandled) {
        await this.logInfo("Captcha not solved in new tab");
        return false;
      }

      await this.delay(2000);

      // Check on 2fa
      const twoFASuccess = await this.handle2FA({ page: newPage });

      if (!twoFASuccess) {
        await this.logInfo("2FA not solved in new tab");
        return false;
      }

      // Check on captcha
      captchaHandled = await this.handleCaptcha({
        sessionUrl: this.sessionUrl,
        page: newPage,
      });

      if (!captchaHandled) {
        await this.logInfo("Captcha not solved in new tab");
        return false;
      }

      await this.delay(2000);

      try {
        await newPage.waitForSelector(
          BOOKING_SELECTORS.reservations.reservationName,
          { timeout: 60000 }
        );
        this.logInfo("Reservation detail page loaded successfully.");
      } catch (error) {
        await dualLogError(
          `[${new Date().toISOString()}] ${getBookingErrorDescription(
            BookingErrorType.RESERVATION_NOT_FOUND
          )}`,
          {
            errorType: BookingErrorType.RESERVATION_NOT_FOUND,
            error: error,
            phase: BookingScrapingPhase.NAVIGATION,
            platform: "booking",
            action: "click_reservation_detail",
          }
        );
        await this.takeScreenshot();
        throw new Error("Reservation detail page did not load as expected.");
      }

      // Process reservation details in the new tab
      const originalPage = this.page;
      this.page = newPage;

      try {
        const success = await this.processReservationDetail(
          reservation,
          jobId,
          propertyId
        );
        if (!success) {
          await this.logInfo(
            `Failed to process reservation detail for ${reservation.id}`
          );
        }
      } finally {
        // Restore original page
        this.page = originalPage;
      }

      // Close the new tab and switch back
      // await newPage.close();
      return true;
    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(
          BookingErrorType.DOM_NOT_FOUND
        )}`,
        {
          errorType: BookingErrorType.DOM_NOT_FOUND,
          error: error,
          phase: BookingScrapingPhase.NAVIGATION,
          platform: "booking",
          reservationId: reservation.id,
          action: "click_reservation_detail",
        }
      );
      return false;
    }
  }

  async traverseAllReservations(
    options: {
      maxPages?: number;
      timeoutMinutes?: number;
      stopOnLastPage?: boolean;
      jobId?: string;
      propertyId?: string;
    } = {}
  ): Promise<{ processed: number; errors: number }> {
    if (!this.page) throw new Error("Page not initialized");

    let processedCount = 0;
    let errorCount = 0;
    const startTime = Date.now();

    try {
      // Get pagination info
      await this.logInfo("Getting pagination information...");
      const paginationInfo = await this.getPaginationInfo();

      const totalPages = paginationInfo ? paginationInfo.totalPages : 1;
      const maxPagesToProcess = options.maxPages
        ? Math.min(options.maxPages, totalPages)
        : totalPages;

      await this.logInfo(
        `Starting reservation traversal: ${totalPages} total pages available, processing up to ${maxPagesToProcess} pages`
      );

      // Process each page
      for (
        let currentPage = 1;
        currentPage <= maxPagesToProcess;
        currentPage++
      ) {
        // Check if scraping should continue
        const shouldStop = await this.checkScrapingShouldStop(
          "traverse_all_reservations",
          { currentPage, totalPages: maxPagesToProcess }
        );
        if (shouldStop) {
          break;
        }

        // Check timeout
        if (this.isTimeoutReached(startTime, options.timeoutMinutes)) {
          await this.logInfo(
            `Timeout reached (${
              options.timeoutMinutes || 60
            } minutes), stopping traversal`
          );
          break;
        }

        const pageResult = await this.processPage(currentPage, totalPages, {
          stopOnLastPage: options.stopOnLastPage,
          jobId: options.jobId,
          propertyId: options.propertyId,
        });
        processedCount += pageResult.processed;
        errorCount += pageResult.errors;

        // Navigate to next page (except for the last page)
        if (currentPage < maxPagesToProcess) {
          const navigationSuccess = await this.navigateToNextPage();
          if (!navigationSuccess) {
            await this.logInfo("No next page available, stopping traversal");
            break;
          }
        }
      }

      await this.logInfo(
        `Reservation traversal completed. Processed: ${processedCount}, Errors: ${errorCount}`
      );
      return { processed: processedCount, errors: errorCount };
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
          action: "traverse_all_reservations",
          processedCount,
          errorCount,
        }
      );
      return { processed: processedCount, errors: errorCount };
    }
  }

  private async processPage(
    currentPage: number,
    totalPages: number,
    options: {
      stopOnLastPage?: boolean;
      jobId?: string;
      propertyId?: string;
    }
  ): Promise<{ processed: number; errors: number }> {
    await this.logInfo(`Processing page ${currentPage}/${totalPages}`);

    // Get and process reservations
    const reservationIds = await this.getReservationRows();

    if (reservationIds.length === 0) {
      await this.logInfo("No reservations found on current page");
      if (options.stopOnLastPage) {
        await this.logInfo("Stopping traversal due to empty page");
        return { processed: 0, errors: 0 };
      }
    }

    //pore

    return await this.processReservations(
      reservationIds,
      options.jobId,
      options.propertyId
    );
  }

  private async processReservations(
    reservationIds: any[],
    jobId?: string,
    propertyId?: string
  ): Promise<{ processed: number; errors: number }> {
    let processedCount = 0;
    let errorCount = 0;

    for (const reservation of reservationIds) {
      // Check if scraping should continue before processing each reservation
      const shouldStop = await this.checkScrapingShouldStop(
        "process_reservations",
        { reservationId: reservation.id }
      );
      if (shouldStop) {
        console.log("Process should Stop");
        break;
      }
      try {
        const success = await this.clickReservationDetail(
          reservation,
          jobId,
          propertyId
        );
        if (success) {
          processedCount++;
          await this.logInfo(
            `Successfully processed reservation ${reservation.id} (${processedCount} total)`
          );
        } else {
          errorCount++;
          await this.logInfo(`Failed to process reservation ${reservation.id}`);
        }
      } catch (error) {
        errorCount++;
        await this.logInfo(
          `Error processing reservation ${reservation.id}: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
      }
    }
    return { processed: processedCount, errors: errorCount };
  }

  private isTimeoutReached(
    startTime: number,
    timeoutMinutes?: number
  ): boolean {
    const timeoutMs = (timeoutMinutes || 60) * 60 * 1000;
    return Date.now() - startTime > timeoutMs;
  }

  private async navigateToNextPage(): Promise<boolean> {
    const nextPageSuccess = await this.goToNextPage();
    if (nextPageSuccess) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return nextPageSuccess;
  }

  private async expandMainMenu(mainSection: string): Promise<boolean> {
    // Wait for page to be ready before clicking menu
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const mainMenuSelectors =
      BOOKING_SELECTORS.navigation.mainMenu(mainSection);
    const clicked = await SelectorUtils.findAndClick(
      this.page!,
      mainMenuSelectors
    );

    if (clicked) {
      // Additional wait after clicking to ensure menu expands
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    return clicked;
  }

  private async clickSubMenu(subSection: string): Promise<boolean> {
    // Submenu time to render - increased for local environment
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Enhanced debugging for VCCS management
    if (subSection === "vccs_management") {
      await this.logInfo("Debugging VCCS management menu...");

      // Log all available menu items for debugging
      const menuItems = await this.page!.evaluate(() => {
        const items = Array.from(
          document.querySelectorAll(
            'a[data-tid="item-link"], a.ext-navigation-submenu-item__link, a'
          )
        );
        return items.map((item) => ({
          text: item.textContent?.trim(),
          href: item.getAttribute("href"),
          dataNavTag: item.closest("li")?.getAttribute("data-nav-tag"),
          className: item.className,
        }));
      });

      // await this.logInfo("Available menu items:", menuItems);
    }

    const subMenuSelectors = BOOKING_SELECTORS.navigation.subMenu(subSection);
    const clicked = await SelectorUtils.findAndClick(
      this.page!,
      subMenuSelectors
    );

    if (!clicked) {
      // Enhanced fallback for VCCS management
      if (subSection === "vccs_management") {
        await this.logInfo("Trying enhanced VCCS management search...");

        // Try additional selectors specific to VCCS
        const vccsFound = await this.page!.evaluate(() => {
          const links = Array.from(document.querySelectorAll("a"));
          for (const link of links) {
            const text = link.textContent?.toLowerCase() || "";
            if (
              text.includes("virtual") ||
              text.includes("vccs") ||
              text.includes("cards")
            ) {
              (link as HTMLElement).click();
              return true;
            }
          }
          return false;
        });

        if (vccsFound) {
          await this.logInfo("Found VCCS management by enhanced text search");
          return true;
        }
      }

      // Fallback: try to find by visible text
      const textFound = await this.page!.evaluate((text) => {
        const links = Array.from(
          document.querySelectorAll(
            'a[data-tid="item-link"], a.ext-navigation-submenu-item__link, a'
          )
        );
        for (const link of links) {
          if (
            link.textContent &&
            link.textContent.toLowerCase().includes(text.toLowerCase())
          ) {
            (link as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, subSection.replace(/_/g, " "));
      return !!textFound;
    }
    return true;
  }

  private async waitForNavigationAndVerify(expectedUrl: string): Promise<void> {
    if (!this.page) throw new Error("Page not initialized");
    await this.page
      .waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 })
      .catch(() => {
        this.logInfo("Navigation timeout after vccs management page");
      });

    const currentUrl = this.page!.url();
    if (!currentUrl.includes(expectedUrl)) {
      throw new Error(
        `Navigation failed - expected ${expectedUrl}, got: ${currentUrl}`
      );
    }
  }

  async navigateToMenuSection(
    mainSection: string,
    subSection: string,
    expectedUrl: string
  ): Promise<boolean> {
    if (!this.page) throw new Error("Page not initialized");
    try {
      // Check if scraping should continue before navigation
      await this.throwIfScrapingShouldStop("navigate_to_menu_section", {
        mainSection,
        subSection,
        expectedUrl,
      });

      await this.logInfo(`Navigating to ${subSection} page`);
      const mainMenuClicked = await this.expandMainMenu(mainSection);
      if (!mainMenuClicked) {
        await this.logError(`${mainSection} menu button not found`);
        await this.takeScreenshot();
        throw new Error(`${mainSection} menu button not found`);
      }

      await this.logInfo(`${mainSection} menu expanded`);

      // Additional wait for menu to fully expand in local environment
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const subMenuClicked = await this.clickSubMenu(subSection);

      if (!subMenuClicked) {
        await this.logError(
          `${subSection} link not found by any selector or text`
        );
        await this.takeScreenshot();
        throw new Error(`${subSection} link not found by any selector or text`);
      }

      await this.logInfo(`Clicked on ${subSection} link`);

      // Additional wait for navigation to start in local environment
      await new Promise((resolve) => setTimeout(resolve, 2000));

      await this.waitForNavigationAndVerify(expectedUrl);
      await this.logInfo(`Successfully navigated to ${subSection} page`);
      await this.takeScreenshot();
      return true;
    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(
          BookingErrorType.DOM_NOT_FOUND
        )}`,
        {
          errorType: BookingErrorType.DOM_NOT_FOUND,
          error: error,
          phase: BookingScrapingPhase.NAVIGATION,
          platform: "booking",
          targetPage: subSection,
          mainSection: mainSection,
        }
      );
      await this.takeScreenshot();
      return false;
    }
  }

  async scrapeData(params: ScrapingJobParams): Promise<ScrapingResult> {
    try {
      // Release OTP for booking.com - notify main thread
      const releaseOtp = (global as any).releaseOtpFromWorker;
      if (releaseOtp) {
        releaseOtp(params.jobId);
      } else {
        // Fallback for non-worker environments
        const { otpStatusManager } = await import(
          "../common/otp-status-manager.js"
        );
        await otpStatusManager.forceReleaseOtp();
      }
      await this.logInfo(
        "Starting complete Booking.com scraping process",
        this.page?.url()
      );

      // Check if scraping should continue before starting
      await this.throwIfScrapingShouldStop("scrape_data", {
        jobId: params.jobId,
        propertyId: params.propertyId,
      });

      // Step 1: Navigate to VCCS Management
      // Try direct navigation first if session params are available
      let navigationSuccess = false;

      if (this.sessionParams && params.propertyId) {
        await this.logInfo(
          "Attempting direct navigation to VCCS Management using session parameters"
        );
        navigationSuccess = await this.navigateDirectlyToVCCS(
          params.propertyId
        );

        if (!navigationSuccess) {
          await this.logWarn(
            "Direct navigation failed, falling back to menu navigation"
          );
        }
      }

      // Fallback to traditional menu navigation if direct navigation not available or failed
      if (!navigationSuccess) {
        await this.logInfo(
          "Using traditional menu navigation to VCCS Management"
        );
        navigationSuccess = await this.navigateToMenuSection(
          "finance",
          "vccs_management",
          "vccs_management"
        );
      }

      if (!navigationSuccess) {
        throw new Error("Failed to navigate to VCCS Management page");
      }

      await this.logInfo("Successfully reached VCCS Management page");

      // Step 2: Click "View all" button to access VCCS to charge
      await this.logInfo('Clicking "View all" button...');
      const viewAllSuccess = await this.clickViewAllVccsToCharge();

      if (!viewAllSuccess) {
        throw new Error(
          'Failed to click "View all" button or navigate to VCCS to charge page'
        );
      }

      await this.logInfo("Successfully navigated to VCCS to charge page");
      this.takeScreenshot();

      // Step 3: Process VCCS data using API (instead of browser automation)
      await this.logInfo("Starting VCCS API-based processing...");

      // Get current URL and extract parameters
      const currentUrl = this.page?.url();
      if (!currentUrl) {
        throw new Error("Failed to get current page URL");
      }
      await this.logInfo(`Current VCCS page URL: ${currentUrl}`);

      // Extract URL parameters
      const urlParams = vccsManagementService.extractUrlParams(currentUrl);
      await this.logInfo("Extracted URL parameters", urlParams);

      // Validate required parameters
      if (
        !urlParams ||
        !urlParams.hotel_id ||
        !urlParams.ses ||
        !urlParams.lang
      ) {
        throw new Error("Missing required URL parameters");
      }

      // Extract cookies and headers from the current page
      const { cookies, headers, hotel_account_id } =
        await vccsManagementService.extractCookiesAndHeaders(this.page!);

      if (!cookies) {
        throw new Error("Failed to extract cookies from page");
      }

      await this.logInfo("Extracted cookies and headers for API calls");

      // Add extracted hotel_account_id to urlParams
      const urlParamsWithAccountId = {
        hotel_id: urlParams.hotel_id,
        ses: urlParams.ses,
        lang: urlParams.lang,
        route: urlParams.route || "vccs_to_charge",
        hotel_account_id,
      };

      // Get VCCS data from API using browser fetch to avoid fingerprinting
      const vccsData = await vccsManagementService.getVccsDataFromBrowser(
        this.page!,
        urlParamsWithAccountId
      );

      if (!vccsData || !vccsData.success) {
        throw new Error("Failed to get VCCS data from API");
      }

      await this.logInfo("Successfully retrieved VCCS data from API");

      // Fetch job from database to get end_date for filtering
      let endDateForFilter: Date | null = null;
      if (params.jobId) {
        try {
          const job = await jobService.getJobById(params.jobId);
          if (job && job.end_date) {
            // Parse end_date from MM/DD/YYYY format to UTC midnight
            const [month, day, year] = job.end_date.split("/");
            endDateForFilter = new Date(
              Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day))
            );
            await this.logInfo(
              `Found end_date in job: ${
                job.end_date
              } (parsed as ${endDateForFilter.toISOString()})`
            );
          } else {
            await this.logInfo(
              "No end_date found in job, will process all reservations"
            );
          }
        } catch (error) {
          await this.logError(
            `Failed to fetch job for filtering: ${
              error instanceof Error ? error.message : "Unknown error"
            }`
          );
          await this.logInfo("Will process all reservations without filtering");
        }
      }

      // Filter reservations based on expiry_date if endDateForFilter is available
      if (endDateForFilter && vccsData.data && vccsData.data.vccs) {
        const originalCount = vccsData.data.vccs.length;

        await this.logInfo(
          `Filtering VCCS reservations by expiry_date <= ${endDateForFilter.toDateString()}`,
          {
            originalCount,
            endDate: endDateForFilter.toDateString(),
            totalReservationsBeforeFilter: originalCount,
          }
        );

        // Log each reservation and whether it passes the filter
        const filteredOut: string[] = [];
        const kept: string[] = [];

        vccsData.data.vccs = vccsData.data.vccs.filter((vccs) => {
          const expiryDate = new Date(vccs.expiry_date);
          const shouldKeep = expiryDate <= endDateForFilter!;

          if (shouldKeep) {
            kept.push(`${vccs.hres_id} (expiry: ${vccs.expiry_date})`);
          } else {
            filteredOut.push(`${vccs.hres_id} (expiry: ${vccs.expiry_date})`);
          }

          return shouldKeep;
        });

        await this.logInfo(`VCCS Filter Results Summary:`, {
          originalCount,
          keptCount: vccsData.data.vccs.length,
          filteredOutCount: filteredOut.length,
          keptReservations:
            kept.length > 10
              ? [...kept.slice(0, 10), `... and ${kept.length - 10} more`]
              : kept,
          filteredOutReservations:
            filteredOut.length > 10
              ? [
                  ...filteredOut.slice(0, 10),
                  `... and ${filteredOut.length - 10} more`,
                ]
              : filteredOut,
        });
      }

      // Process all VCCS reservations to get card details using browser fetch
      const processingResult =
        await vccsManagementService.processAllVccsReservationsFromBrowser(
          this.page!,
          vccsData,
          urlParamsWithAccountId,
          params.jobId,
          this.propertyIdForDb, // Use propertyIdForDb (MongoDB ObjectId), not hotel_id
          this // Pass scraper instance for captcha/2FA handling
        );

      await this.logInfo("VCCS API Processing Results:");
      await this.logInfo(
        `Successfully processed: ${processingResult.processed} reservations`
      );
      await this.logInfo(`Errors encountered: ${processingResult.errors}`);

      // Step 4: Take final screenshot
      await this.takeScreenshot();

      // Prepare the result data
      const data = {
        platform: "booking",
        timestamp: new Date().toISOString(),
        jobId: params.jobId,
        propertyId: params.propertyId,
        navigation: {
          vccsManagement: navigationSuccess,
          viewAllButton: viewAllSuccess,
        },
        vccsProcessing: {
          processed: processingResult.processed,
          errors: processingResult.errors,
          method: "api",
        },
      };

      await this.logInfo("Booking.com scraping completed successfully");

      return {
        success: true,
        data,
      };
    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(
          BookingErrorType.UNKNOWN
        )}`,
        {
          errorType: BookingErrorType.UNKNOWN,
          error: error,
          phase: BookingScrapingPhase.NAVIGATION,
          jobId: params.jobId,
          propertyId: params.propertyId,
          platform: "booking",
          action: "scrape_data",
        }
      );

      await this.takeScreenshot();

      return {
        success: false,
        error: error instanceof Error ? error.message : "Scraping failed",
        screenshots: [`booking-scraping-error-${Date.now()}.png`],
      };
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
        await this.browser.close();
        await this.logInfo("Browser closed successfully");
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
      await this.logInfo("Creating Browserless session with UI access");

      const sessionConfig = {
        ttl: 86400000, // 24h
        stealth: true,
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--enable-javascript",
          "--disable-web-security",
          "--window-size=2560,1440",
        ],
      };

      const response = await fetch(
        `https://production-sfo.browserless.io/session?token=${this.browserlessToken}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sessionConfig),
        }
      );

      await this.logInfo(
        `Response status: ${response.status} ${response.statusText}`
      );

      if (!response.ok) {
        const errorText = await response.text();
        await this.logError(
          `Failed to create session: ${response.status} "${errorText}"`
        );
        return null;
      }

      const session = (await response.json()) as any;

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

  /**
   * Send password change notification email for all properties with the same username
   */
  private async sendPasswordChangeEmail(
    newPassword: string,
    reason: string,
    updateResult: {
      success: boolean;
      affectedProperties: Array<{ propertyId: string; propertyName: string }>;
      username: string;
      totalUpdated: number;
    }
  ): Promise<void> {
    try {
      if (!this.jobId) {
        await this.logError(
          "Cannot send password change email: No jobId available"
        );
        return;
      }

      // Get job details to retrieve watcher emails
      const job = await jobService.getJobById(this.jobId);
      if (!job) {
        await this.logError(
          `Cannot send password change email: Job not found for jobId: ${this.jobId}`
        );
        return;
      }

      // Build recipients list: EMAIL_USER + watcher_emails from job + PASSWORD_CHANGE_RECIPIENTS
      const emailSet = new Set<string>();

      // Add EMAIL_USER (main recipient)
      if (process.env.EMAIL_USER) {
        emailSet.add(process.env.EMAIL_USER);
      }

      // Add watcher emails from job
      if (job.watcher_emails && Array.isArray(job.watcher_emails)) {
        job.watcher_emails.forEach((email: string) => {
          if (email && email.trim()) {
            emailSet.add(email.trim());
          }
        });
      }

      // Add PASSWORD_CHANGE_RECIPIENTS if configured
      if (process.env.PASSWORD_CHANGE_RECIPIENTS) {
        process.env.PASSWORD_CHANGE_RECIPIENTS.split(",").forEach((email) => {
          const trimmedEmail = email.trim();
          if (trimmedEmail) {
            emailSet.add(trimmedEmail);
          }
        });
      }

      // Add CAPTCHA_RECIPIENTS as fallback
      if (emailSet.size === 0 && process.env.CAPTCHA_RECIPIENTS) {
        process.env.CAPTCHA_RECIPIENTS.split(",").forEach((email) => {
          const trimmedEmail = email.trim();
          if (trimmedEmail) {
            emailSet.add(trimmedEmail);
          }
        });
      }

      // Fallback to default if still empty
      if (emailSet.size === 0) {
        emailSet.add("ITSUPPORT@vnpsolutions.com");
      }

      const recipients = Array.from(emailSet);

      // Get property details for this job's property (the one that triggered the change)
      const propertyDetails =
        await propertyPasswordUpdateService.getPropertyDetailsFromJobId(
          this.jobId
        );

      if (!propertyDetails) {
        await this.logError(
          `Cannot send password change email: No property found for job ${this.jobId}`
        );
        return;
      }

      // Prepare notification data with all affected properties
      const notificationData = {
        jobId: this.jobId,
        propertyName: propertyDetails.propertyName,
        portfolioName: propertyDetails.portfolioName,
        newPassword: newPassword,
        timestamp: new Date(),
        reason: reason,
        username: updateResult.username,
        affectedProperties: updateResult.affectedProperties,
        totalUpdated: updateResult.totalUpdated,
      };

      await emailNotifier.sendPasswordChangeEmail(recipients, notificationData);
      
      if (updateResult.affectedProperties.length > 1) {
        await this.logInfo(
          `Password change notification email sent to ${recipients.join(
            ", "
          )} for ${updateResult.affectedProperties.length} properties: ${updateResult.affectedProperties
            .map((p) => p.propertyName)
            .join(", ")}`
        );
      } else {
        await this.logInfo(
          `Password change notification email sent to ${recipients.join(
            ", "
          )} for property: ${propertyDetails.propertyName}`
        );
      }
    } catch (error) {
      await this.logError(
        "Failed to send password change notification email:",
        error
      );
    }
  }

  private async sendCaptchaEmail(): Promise<void> {
    try {
      // Get email recipients from environment variable
      const recipients = process.env.CAPTCHA_RECIPIENTS
        ? process.env.CAPTCHA_RECIPIENTS.split(",").map((email) => email.trim())
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

      if (this.context === ScraperContext.TRUST_VERIFICATION) {
        await emailNotifier.sendErrorEmail(recipients, {
          jobId: "Trust Verification",
          jobName: "",
          errorMessage,
          errorDetails,
          timestamp: new Date(),
        });
      } else {
        await emailNotifier.notifyJobError(
          this.jobId || "Unknown job",
          errorMessage,
          errorDetails,
          undefined,
          recipients
        );
      }
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

  private async clickCardDetailsFromRow(
    reservationId: string
  ): Promise<boolean> {
    if (!this.page) throw new Error("Page not initialized");

    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        attempt++;
        await this.logInfo(
          `Looking for "View card details" link for reservation ${reservationId} (attempt ${attempt}/${maxRetries})`
        );

        await this.page.waitForSelector("tr.bui-table__row", {
          timeout: 10000,
        });
        await this.logInfo(`Fetched table`);

        // Find the reservation row that contains the specific reservation ID
        const cardDetailsClicked = await this.page.evaluate((resId) => {
          // Find all reservation rows
          const rows = Array.from(
            document.querySelectorAll("tr.bui-table__row")
          );

          for (const row of rows) {
            // Look for the reservation ID link in this row
            const reservationLink = row.querySelector(
              `a[href*="res_id=${resId}"]`
            );

            if (reservationLink) {
              // Found the row with this reservation ID, now look for "View card details" link
              const cardDetailsLink = row.querySelector(
                "a.pay-hub__view_cc_link"
              );

              if (cardDetailsLink) {
                // Click the "View card details" link
                (cardDetailsLink as HTMLElement).click();
                return true;
              }
            }
          }

          return false;
        }, reservationId);

        if (cardDetailsClicked) {
          await this.logInfo('Successfully clicked "View card details" link');
          return true;
        } else {
          await this.logError(
            `Could not find "View card details" link for reservation ${reservationId}`
          );
          await this.takeScreenshot();

          if (attempt < maxRetries) {
            await this.logInfo(`Retrying in 2 seconds...`);
            await delay(2000);

            await this.page.reload();
            await this.page.waitForSelector(BOOKING_SELECTORS.vccs.table, {
              timeout: 30000,
            });
          } else {
            await this.logError("Failed to click card details from row");
            return false;
          }
        }
      } catch (error) {
        await this.logError("Error clicking card details from row:", error);

        if (attempt < maxRetries) {
          await this.logInfo(`Retrying in 2 seconds...`);
          await delay(2000);
        }

        await this.takeScreenshot();
        return false;
      }
    }

    await this.logError(
      `Failed to click card details after ${maxRetries} attempts for reservation ${reservationId}`
    );
    return false;
  }

  private async extractCardDetailsFromPage(page: Page): Promise<{
    cardNumber: string;
    expiry: string;
    cvv: string;
    cardholder: string;
    amountToChargeOrRefund: string;
  } | null> {
    try {
      const cardData = await page.evaluate(() => {
        const result: {
          cardNumber: string;
          expiry: string;
          cvv: string;
          cardholder: string;
          amountToChargeOrRefund: string;
        } = {
          cardNumber: "",
          expiry: "",
          cvv: "",
          cardholder: "",
          amountToChargeOrRefund: "",
        };

        const labelMap: Record<string, keyof typeof result> = {
          "Card number:": "cardNumber",
          "Expiration Date:": "expiry",
          "CVC Code:": "cvv",
          "Card holder's name:": "cardholder",
        };

        const rows = document.querySelectorAll("table tr");
        rows.forEach((row) => {
          const cells = row.querySelectorAll("td");
          if (cells.length === 2) {
            const label = cells[0].textContent?.trim() || "";
            const value = cells[1].textContent?.trim() || "";
            const key = labelMap[label];
            if (key) {
              result[key] = value;
            }
          }
        });

        // Extract remaining balance
        const balanceElement = Array.from(
          document.querySelectorAll("p span")
        ).find((span) =>
          span.previousSibling?.textContent?.includes("remaining balance")
        );

        if (balanceElement) {
          result.amountToChargeOrRefund =
            balanceElement.textContent?.trim() || "";
        }

        return result;
      });

      await this.logInfo("Extracted card details", cardData);
      return cardData;
    } catch (error) {
      await this.logError("Failed to extract card details", error);
      return null;
    }
  }

  private async extractBasicReservationData(): Promise<any> {
    if (!this.page) throw new Error("Page not initialized");
    await this.delay(5000);

    try {
      const basicData = await this.page.evaluate(() => {
        const result: Record<string, string> = {
          guestName: "",
          checkInDate: "",
          checkOutDate: "",
          totalAmount: "",
          reservationId: "",
          bookedDate: "",
          totalPayout: "",
          roomType: "",
          reservationStatus: "",
        };

        const labelMap: Record<string, keyof typeof result> = {
          "Guest name:": "guestName",
          "Check-in": "checkInDate",
          "Check-out": "checkOutDate",
          "Total price": "totalAmount",
          "Booking number:": "reservationId",
          Received: "bookedDate",
          "Commissionable amount:": "totalPayout",
        };

        // Extract all label elements
        const labels = document.querySelectorAll(".res-content__label");
        labels.forEach((labelEl) => {
          const labelText = labelEl.textContent?.trim();
          const mappedKey = labelMap[labelText as keyof typeof labelMap];
          if (mappedKey) {
            const valueEl = labelEl.nextElementSibling;
            const value = valueEl?.textContent?.trim() || "";
            result[mappedKey] = value;
          }
        });

        // Room type and guest name might be outside label structure
        const guestEl = document.querySelector(
          '[data-test-id="reservation-overview-name"]'
        );
        if (guestEl)
          result.guestName = guestEl.textContent?.trim() || result.guestName;

        const roomTypeEl = document.querySelector(".res-room-title__name");
        if (roomTypeEl)
          result.roomType = roomTypeEl.textContent?.trim() || result.roomType;

        const statusEl = document.querySelector(
          ".res-view-cc__badge span span"
        );
        if (statusEl)
          result.reservationStatus = statusEl.textContent?.trim() || "";

        return result;
      });

      await this.logInfo("Extracted basic reservation data", basicData);
      return basicData;
    } catch (error) {
      await this.logError("Failed to extract basic reservation data", error);
      return null;
    }
  }

  async saveReservationToDatabase(
    jobId: string,
    basicData: any,
    cardData: any
  ): Promise<any> {
    try {
      // Validate inputs
      if (!jobId || !this.propertyIdForDb) {
        throw new Error("JobId and propertyIdForDb are required");
      }

      // Parse dates
      const parseDate = (dateStr: string): Date => {
        if (!dateStr) return new Date();

        // Handle different date formats
        if (dateStr.includes("/")) {
          // Format: MM/DD/YYYY
          return new Date(dateStr);
        } else if (dateStr.includes("-")) {
          // Format: YYYY-MM-DD
          return new Date(dateStr);
        } else {
          // Try to parse as-is
          const parsed = new Date(dateStr);
          return isNaN(parsed.getTime()) ? new Date() : parsed;
        }
      };

      // Parse amount
      const parseAmount = (amountStr: string): number => {
        if (!amountStr) return 0;
        const cleaned = amountStr.replace(/[^\d.-]/g, "");
        const amount = parseFloat(cleaned);
        return isNaN(amount) ? 0 : Math.abs(amount);
      };

      const jobItemData = {
        job_id: jobId,
        property_id: this.propertyIdForDb,
        guest_name: basicData.guestName || "Unknown Guest",
        reservation_id: basicData.reservationId || "Unknown",
        confirmation_number: basicData.bookingNumber || "Unknown", // Use booking number as confirmation
        check_in_date: parseDate(basicData.checkInDate),
        check_out_date: parseDate(basicData.checkOutDate),
        room_type: basicData.roomType || "Unknown",
        booking_amount: parseAmount(basicData.totalAmount),
        booked_date: parseDate(basicData.receivedDate),
        has_card_info: !!cardData.cardNumber,
        has_payment_info: !!basicData.totalPayout,
        payment_info: {
          total_guest_payment: parseAmount(basicData.totalAmount),
          total_payout: parseAmount(basicData.totalPayout),
          amount_to_charge_or_refund: parseAmount(basicData.amount) || 0,
          cancellation_fee: 0, // update later
          charge_before: basicData.chargeBefore,
        },
        card_info: {
          expiry_date: cardData.expiry,
          card_number: cardData.cardNumber,
          cvv: cardData.cvv,
          card_holder_name: cardData.cardholder,
        },
        reservation_status: basicData.reservationStatus || "Unknown",
      };

      this.logInfo(`JobData to be saved: `, jobItemData);

      // Check if reservation already exists
      const existingReservation = await jobService.findJobItemByReservationId(
        jobId,
        basicData.reservationId
      );

      if (existingReservation) {
        const updatedItem = await jobService.updateJobItem(
          existingReservation._id.toString(),
          jobItemData
        );
        await this.logInfo(
          `Updated reservation ${basicData.reservationId} with new data`
        );
        return updatedItem;
      } else {
        const savedItem = await jobService.createJobItem(jobItemData);

        await this.logInfo(
          `Saved reservation ${basicData.reservationId} to database`
        );
        return savedItem;
      }
    } catch (error) {
      await this.logError(`Failed to save reservation to database:`, error);
      return null;
    }
  }

  async processReservationDetail(
    reservation: any,
    jobId?: string,
    propertyId?: string
  ): Promise<boolean> {
    try {
      // Check if scraping should continue before processing reservation detail
      await this.throwIfScrapingShouldStop("process_reservation_detail", {
        reservationId: reservation.id,
        jobId,
        propertyId,
      });

      await this.logInfo(`Processing reservation detail: ${reservation.id}`);

      // Extract reservation basic data
      if (!this.page) throw new Error("Page not initialized");
      const basicData = await this.extractBasicReservationData();

      if (!basicData) {
        await this.logError("Failed to extract basic reservation data");
      }

      basicData.amount = reservation.amount;
      basicData.chargeBefore = reservation.chargeBefore;

      await this.logInfo("Basic reservation data extracted successfully");

      // Go back to the previous page
      await this.logInfo("Going back to VCCS Management list");
      // await this.page.goBack(); // throws captcha & 2fa

      // I do this workaround in order to avoid captcha and 2fa
      await this.navigateToMenuSection(
        "finance",
        "vccs_management",
        "vccs_management"
      );
      await delay(2000);
      await this.clickViewAllVccsToCharge();

      await this.page.waitForSelector(BOOKING_SELECTORS.vccs.table, {
        timeout: 30000,
      });

      await this.takeScreenshot();

      // Listen for new page creation for card details view
      const newPagePromise = new Promise<Page>((resolve) => {
        this.browser!.once("targetcreated", async (target) => {
          if (target.type() === "page") {
            const newPage = await target.page();
            await newPage!.bringToFront();
            resolve(newPage!);
          }
        });
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("Timeout waiting for new tab to open")),
          30000
        );
      });

      const cardDetailsClick = this.clickCardDetailsFromRow(reservation.id);
      if (!cardDetailsClick) {
        await this.logError(
          `Failed to extract data for reservation ${reservation.id}`
        );
      }

      let newPage = undefined;

      try {
        const newPage = await Promise.race([newPagePromise, timeoutPromise]);
        this.page = newPage; // switch page
      } catch (error) {
        await this.logError("Timeout waiting for new tab to open:", error);
        return false;
      }

      // Check and handle login on the new page
      const needsLogin = await this.checkIfLoginNeeded(newPage);
      if (needsLogin) {
        // skip already logged in check
        await this.login(this.credentials, undefined, true);
      }

      // Check on 2fa
      const twoFASuccess = await this.handle2FA({ page: newPage });

      if (!twoFASuccess) {
        await this.logInfo("2FA not solved in new tab");
        return false;
      }

      const cardData = await this.extractCardDetailsFromPage(this.page);

      // Close page
      await SelectorUtils.findAndClick(
        this.page,
        BOOKING_SELECTORS.reservations.closeCardDetails
      );

      // Save to database if jobId and propertyId are provided
      if (jobId && propertyId) {
        await this.saveReservationToDatabase(jobId, basicData, cardData);
      }

      await this.logInfo(
        `Successfully processed reservation ${reservation.id}`
      );
      return true;
    } catch (error) {
      await this.logError(
        `Error processing reservation ${reservation.id}:`,
        error
      );
      return false;
    }
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
      throw new Error(`Scraping was stopped during ${action || "operation"}`);
    }
  }
}
