import puppeteer, { Browser, Page } from "puppeteer";
import fs from 'fs';
import readline from 'readline';
import fetch from 'node-fetch';
import { BaseScraper, LoginCredentials, CaptchaHandlerOptions, TwoFactorAuthOptions, ScrapingJobParams, ScrapingResult } from "./base-scraper.js";
import { timeoutManager } from "../common/timeout-manager.js";
import handleBookingOtpVerification from "../otp-verification/booking-otp-verification.js";
import { SelectorUtils } from "../common/selector-utils.js";
import { BOOKING_LOGIN_EXCLUDE_URLS, BOOKING_LOGIN_SUCCESS_URLS, BOOKING_SELECTORS, CAPTCHA_PATTERNS, TWO_FA_PATTERNS, TWO_FA_TEXT_PATTERNS } from "../common/booking-selectors.js";
import { 
  BookingErrorType, 
  BookingScrapingPhase, 
  shouldRetryBookingError, 
  getBookingErrorDescription 
} from "../common/booking-error-types.js";
import { dualLogError } from "../common/log-helper.js";

export class BookingScraper extends BaseScraper {
  private cookiesFile = 'booking-admin-cookies.json';
  private browserlessToken: string;
  private sessionUrl?: string;

  constructor() {
    super('booking', 'https://admin.booking.com');
    this.browserlessToken = process.env.BROWSERLESS_TOKEN || '2SXlnLjeZpwR2tV6ab1698bfe680a3959c2c681f06939ee3b';
  }

  async setupBrowser(jobId?: string): Promise<{ browser: Browser; page: Page }> {
    try {
      await this.logInfo('Setting up Booking.com browser with Browserless session');

      // Get timeout configuration
      const loadingTimeout = jobId ? await timeoutManager.getLoadingTimeout(jobId) : 120000;
      const selectorTimeout = jobId ? await timeoutManager.getSelectorTimeout(jobId) : 30000;

      // Create Browserless session for UI access
      const session = await this.createBrowserlessSession();
      if (session && session.id) {
        await this.logInfo("Browserless UI session created");
      } else {
        await this.logInfo("Failed to create Browserless session, falling back to local browser");
        // Fallback to local browser
        const browser = await puppeteer.launch({
          headless: false,
          defaultViewport: null,
          args: [
            "--start-maximized",
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-web-security",
            "--disable-features=IsolateOrigins,site-per-process",
            "--disable-blink-features=AutomationControlled",
            "--disable-extensions",
          ],
        });
        const page = await browser.newPage();
        await page.setUserAgent(
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        );
        await this.logInfo("Local browser setup completed as fallback");
        return { browser, page };
      }

      // Connect to the created Browserless session
      const browser = await puppeteer.connect({
        browserWSEndpoint: session.connect,
        protocolTimeout: 300000
      });

      const page = await browser.newPage();
      
      await this.logInfo("Connected to Browserless session successfully");
      
      // Set viewport and timeouts
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setDefaultNavigationTimeout(loadingTimeout);
      await page.setDefaultTimeout(selectorTimeout);

      // Start recording and generate live URL for captcha solving
      const cdp = await page.createCDPSession();
      await (cdp as any).send("Browserless.startRecording");
      await this.logInfo("Recording started successfully");

      await this.delay(2000);

      try {
        const { liveURL } = (await (cdp as any).send("Browserless.liveURL", {
          timeout: 600_000,
        })) as { liveURL: string };
        
        this.sessionUrl = liveURL;
        await this.logInfo("Live URL generated for captcha solving:", { liveURL });

      } catch (liveUrlError) {
        await this.logError("Failed to generate live URL:", liveUrlError);
        await this.logInfo("Live URL generation failed - will use session URL instead");
        this.sessionUrl = `https://production-sfo.browserless.io?token=${this.browserlessToken}#/live/${session.id}`;
      }

      // Load saved cookies if they exist
      if (fs.existsSync(this.cookiesFile)) {
        const cookies = JSON.parse(fs.readFileSync(this.cookiesFile, 'utf8'));
        await page.setCookie(...cookies);
        await this.logInfo(`Loaded ${cookies.length} saved cookies`);
      }

      // Navigate to login page
      await this.logInfo('Navigating to Booking.com admin portal');
      try {
        await page.goto(this.baseUrl, {
          waitUntil: 'networkidle2',
          timeout: loadingTimeout
        });
      } catch (navError) {
        await this.logInfo('Navigation slow, trying with domcontentloaded');
        await page.goto(this.baseUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 60000
        });
        await this.delay(5000);
      }

      await this.takeScreenshot('booking-initial-page.png');
      
      return { browser, page };
    } catch (error) {
      await this.logError('Browser setup failed', error);
      throw error;
    }
  }

  /**
   * Handle property search after successful login or when already logged in
   */
  private async handlePropertySearch(propertyId?: string): Promise<void> {
    if (!propertyId) {
      await this.logInfo('No property ID provided, skipping property search');
      return;
    }

    await this.logInfo('Checking for multi-property account and searching for property');
    const isMultiProperty = await this.checkMultiPropertyAccount();
    
    if (isMultiProperty) {
      await this.logInfo('Multi-property account detected, searching for property');
      const searchSuccess = await this.searchProperty(propertyId);
      if (searchSuccess) {
        await this.logInfo('Property search and selection completed successfully');
      } else {
        await this.logError('Property search failed');
      }
    } else {
      await this.logInfo('Single property account detected, no property search needed');
    }
  }

  /**
   * Handle successful login completion
   */
  private async handleSuccessfulLogin(propertyId?: string): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');
    
    await this.logInfo('Login successful');
    const cookies = await this.page.cookies();
    fs.writeFileSync(this.cookiesFile, JSON.stringify(cookies, null, 2));
    await this.logInfo(`Saved ${cookies.length} cookies for future sessions`);
    await this.takeScreenshot('booking-admin-dashboard.png');
    
    await this.handlePropertySearch(propertyId);
  }

  /**
   * Handle successful 2FA completion
   */
  private async handleSuccessful2FA(propertyId?: string): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');
    
    await this.logInfo('2FA completed successfully');
    const cookies = await this.page.cookies();
    fs.writeFileSync(this.cookiesFile, JSON.stringify(cookies, null, 2));
    await this.logInfo(`Saved ${cookies.length} cookies after 2FA`);
    await this.takeScreenshot('booking-admin-dashboard-after-2fa.png');
    
    await this.handlePropertySearch(propertyId);
  }

  /**
   * Check if user is already logged in
   */
  private isAlreadyLoggedIn(): boolean {
    if (!this.page) return false;

    const finalUrl = this.page.url();

    const isIncluded = BOOKING_LOGIN_SUCCESS_URLS.some(url => finalUrl.includes(url));
    const isExcluded = BOOKING_LOGIN_EXCLUDE_URLS.some(url => finalUrl.includes(url));

    return isIncluded && !isExcluded;
  }

  async login(credentials: LoginCredentials, propertyId?: string): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');

    try {
      if (this.isAlreadyLoggedIn()) {
        await this.logInfo('Already logged in');
        await this.handlePropertySearch(propertyId);
        return;
      }

      await this.logInfo('Starting login process');

      await this.handleCaptcha({
        type: 'browserless_ui',
        sessionUrl: this.sessionUrl,
        timeout: 180000
      });

      await this.logInfo('Entering email address');
      
      const emailEntered = await this.enterEmail(credentials.email);
      if (!emailEntered) {
        await this.takeScreenshot('booking-no-email-field.png');
        throw new Error('Email field not found');
      }

      await this.logInfo('Clicking Continue with email');
      const continueClicked = await this.clickContinueButton();

      if (!continueClicked) {
        throw new Error('Continue Button not found');
      }

      await this.takeScreenshot('booking-after-email.png');
      await this.delay(5000);

      // Check for captcha after email submission
      await this.handleCaptcha({
        type: 'browserless_ui',
        sessionUrl: this.sessionUrl,
        timeout: 180000
      });

      await this.logInfo('Looking for password field');
   
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
            continue
          }
        }

        if (!passwordField) {
          attempts++;
          await this.logInfo(`Attempt ${attempts}/${maxAttempts} - waiting for password field`);
          await this.delay(5000);
        }
      }

      if (!passwordField) {
        await this.takeScreenshot('booking-no-password-field.png');
        throw new Error('Password field not found after multiple attempts');
      }

      // Enter password using the new function
      const passwordEntered = await this.enterPassword(credentials.password);
      if (!passwordEntered) {
        await this.takeScreenshot('booking-password-entry-failed.png');
        throw new Error('Failed to enter password');
      }

      await this.logInfo('Submitting login');

      const loginClicked = await this.clickLoginButton();
      if (!loginClicked) {
        throw new Error('Login Button not found');
      }

      // Check for captcha after login submission
      await this.handleCaptcha({
        type: 'browserless_ui',
        sessionUrl: this.sessionUrl,
        timeout: 180000
      });      

      await this.takeScreenshot('booking-after-password.png');

      // Wait for navigation
      await this.logInfo('Waiting for login response');
      await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

      // Check for login errors
      await this.checkLoginErrors();

      // Handle successful login
      if (this.isAlreadyLoggedIn()) {
        await this.handleSuccessfulLogin(propertyId);
      } else {
        await this.logInfo('Login requires 2FA verification');
        
        // Try to handle 2FA automatically
        const twoFASuccess = await this.handle2FA();
        if (twoFASuccess) {
          await this.handleSuccessful2FA(propertyId);
        } else {
          await dualLogError(
            `[${new Date().toISOString()}] ${getBookingErrorDescription(BookingErrorType.TWO_FA_ERROR)}`,
            {
              errorType: BookingErrorType.TWO_FA_ERROR,
              phase: BookingScrapingPhase.LOGIN,
              platform: 'booking'
            }
          );
          await this.takeScreenshot('booking-2fa-failed.png');
          throw new Error('2FA verification failed');
        }
      }

    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(BookingErrorType.LOGIN_FAILED)}`,
        {
          errorType: BookingErrorType.LOGIN_FAILED,
          error: error,
          phase: BookingScrapingPhase.LOGIN,
          platform: 'booking'
        }
      );
      await this.takeScreenshot('booking-login-error.png');
      throw error;
    }
  }

  /**
   * Check if the logged-in account has multiple properties
   * This method checks for the multi-property URL pattern
   */
  async checkMultiPropertyAccount(): Promise<boolean> {
    if (!this.page) throw new Error('Page not initialized');

    try {
      const currentUrl = this.page.url();
      await this.logInfo(`Checking multi-property account. Current URL: ${currentUrl}`);
      
      // Check if URL contains multi-property indicators
      const isMultiProperty = currentUrl.includes('/groups/home/') || 
                             currentUrl.includes('hoteladmin/groups/') ||
                             currentUrl.includes('multi-property');
      
      await this.logInfo(`Multi-property account detected: ${isMultiProperty}`);
      return isMultiProperty;
    } catch (error) {
      await this.logError('Error checking multi-property account:', error);
      return false;
    }
  }

  private async checkIfLoginNeeded(): Promise<boolean> {
    if (!this.page) throw new Error('Page not initialized');

    try {
      const hasLoginForm = await SelectorUtils.trySelectors(
        this.page,
        [...BOOKING_SELECTORS.email, ...BOOKING_SELECTORS.password],
        async (selector: string) => {
          const el = await this.page!.$(selector);
          return !!el;
        },
        5000
      );
      
      if (hasLoginForm) {
        await this.logInfo('Login required detected via URL or form elements');
        return true;
      }
      
      await this.logInfo('No login required detected');
      return false;
    } catch (error) {
      await this.logError('Error checking if login is needed:', error);
      return false;
    }
  }

  async searchProperty(propertyId: string): Promise<boolean> {
    if (!this.page) throw new Error('Page not initialized');

    try {
      await this.logInfo(`Searching for property ID: ${propertyId}`);
      
      const searchInputFound = await SelectorUtils.findAndType(
        this.page,
        BOOKING_SELECTORS.property.searchInput,
        propertyId
      );
      
      if (!searchInputFound) {
        await this.logError('Property search input not found');
        await this.takeScreenshot('booking-no-search-input.png');
        return false;
      }
      
      await this.logInfo('Property ID entered in search field');
      
      const propertySelectors = BOOKING_SELECTORS.property.item(propertyId);
      const propertyClicked = await SelectorUtils.findAndClick(this.page, propertySelectors);
      
      if (!propertyClicked) {
        // TO DO - add logs
        await this.logInfo('Property not found with predefined selectors, trying alternative approaches...');
      }
      
      await this.logInfo('Property clicked successfully');
      
      // Listen for new page creation for property selection
      const newPagePromise = new Promise<Page>((resolve) => {
        this.browser!.once('targetcreated', async (target) => {
          if (target.type() === 'page') {
            const newPage = await target.page();
            await newPage!.bringToFront();
            resolve(newPage!);
          }
        });
      });

      // Wait for the new page to be created
      const newPage = await newPagePromise;
      
      // Switch to the new page and keep it
      this.page = newPage;
      
      try {
        // Verify property is selected by checking URL
        const currentUrl = this.page.url();
        await this.logInfo(`New page URL: ${currentUrl}`);
        
        if (currentUrl.includes(`hotel_id=${propertyId}`)) {
          await this.logInfo('Property selection verified via URL');
          await this.takeScreenshot('booking-property-selected.png');
          return true;
        } else {
          await this.logInfo('Property selection verification failed, checking if login is needed');
          await this.takeScreenshot('booking-property-selection-verification.png');
          
          // Check if we need to login again
          const needsLogin = await this.checkIfLoginNeeded();
          if (needsLogin) {
            await this.logInfo('Login required, attempting to login again');
            return false; // Indicate login is needed
          } else {
            await this.logInfo('Property selection verification inconclusive but no login needed');
            return true; // Assume success if we can't verify and no login needed
          }
        }
        
      } catch (error) {
        await this.logError('Error in property verification:', error);
        return false;
      }
      
    } catch (error) {
      await this.logError('Error searching and selecting property:', error);
      await this.takeScreenshot('booking-property-search-error.png');
      return false;
    }
  }

  async handleCaptcha(options?: CaptchaHandlerOptions): Promise<boolean> {
    const currentPage = options?.page || this.page;

    if (!currentPage) return false;

    try {
      const pageContent = await currentPage.content();
      const hasCaptcha = CAPTCHA_PATTERNS.some(pattern => pattern.test(pageContent));

      if (!hasCaptcha) {
        await this.logInfo('No captcha detected');
        return true;
      }

      await this.logInfo('Captcha detected');
      await this.takeScreenshot('booking-captcha.png');

      if (options?.type === 'automatic') {
        return await this.solveCaptchaAutomatically();
      } else if (options?.type === 'browserless_ui' && options.sessionUrl) {
        return await this.solveCaptchaWithUI(options.sessionUrl, options.timeout || 180000);
      } else {
        return await this.solveCaptchaManually(options?.timeout || 180000);
      }
    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(BookingErrorType.CAPTCHA)}`,
        {
          errorType: BookingErrorType.CAPTCHA,
          error: error,
          phase: BookingScrapingPhase.LOGIN,
          platform: 'booking'
        }
      );
      return false;
    }
  }

  async handle2FA(options?: TwoFactorAuthOptions): Promise<boolean> {
    const currentPage = options?.page || this.page;

    if (!currentPage || !this.browser) return false;

    try {
      const currentUrl = currentPage.url();
      
      // Check if we're on a verification-related page
      const needsVerification = TWO_FA_PATTERNS.some(pattern => currentUrl.includes(pattern));

      if (!needsVerification) {
        // Check page content for verification indicators
        const pageContent = await currentPage.content();
        const hasVerificationContent = TWO_FA_TEXT_PATTERNS.some(text => pageContent.includes(text));

        if (!hasVerificationContent) {
          await this.logInfo('No 2FA required');
          return true;
        }
      }

      await this.logInfo('2FA verification required, using automated OTP handler');
      await this.takeScreenshot('booking-2fa-page.png');

      try {
        await handleBookingOtpVerification(this.browser, currentPage);
        await this.logInfo('Automated OTP verification completed successfully');
        return true;
      } catch (otpError) {
        await dualLogError(
          `[${new Date().toISOString()}] [booking] Automated OTP verification failed, falling back to manual method`,
          {
            errorType: BookingErrorType.TWO_FA_ERROR,
            error: otpError,
            phase: BookingScrapingPhase.LOGIN,
            platform: 'booking'
          }
        );
        
        // Fallback to manual 2FA if automated fails
        if (this.sessionUrl) {
          await this.logInfo(`Manual 2FA can be completed in Browserless UI: ${this.sessionUrl}`);
        }

        // Find OTP input field for manual entry
        for (const selector of BOOKING_SELECTORS.tfaSelectors) {
          try {
            await currentPage.waitForSelector(selector, { timeout: 10000 });
            await this.logInfo(`Found 2FA field for manual entry: ${selector}`);
            
            const code = await this.prompt2FA(options?.timeout || 120000);
            await currentPage.type(selector, code, { delay: 100 });
            await currentPage.keyboard.press('Enter');
            await this.logInfo('Manual 2FA code submitted');
            
            await currentPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {
              this.logInfo('Navigation timeout after manual 2FA');
            });
            
            return true;
          } catch (e) {
            // Try next selector
            continue;
          }
        }

        await dualLogError(
          `[${new Date().toISOString()}] [booking] Both automated and manual 2FA methods failed`,
          {
            errorType: BookingErrorType.TWO_FA_ERROR,
            phase: BookingScrapingPhase.LOGIN,
            platform: 'booking'
          }
        );
        return false;
      }
    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(BookingErrorType.TWO_FA_ERROR)}`,
        {
          errorType: BookingErrorType.TWO_FA_ERROR,
          error: error,
          phase: BookingScrapingPhase.LOGIN,
          platform: 'booking'
        }
      );
      return false;
    }
  }

  async clickViewAllVccsToCharge(): Promise<boolean> {
    return await SelectorUtils.findAndClick(this.page!, [BOOKING_SELECTORS.vccs.vccsToChargeLink]);

  }

  async getPaginationInfo(): Promise<{ currentPage: number; totalPages: number } | null> {
    if (!this.page) throw new Error('Page not initialized');

    try {
      const currentPageElement = await this.page.$(BOOKING_SELECTORS.pagination.currentPageIndicator);
      const totalPagesElement = await this.page.$(BOOKING_SELECTORS.pagination.totalPagesIndicator);

      if (currentPageElement && totalPagesElement) {
        const currentPage = await currentPageElement.evaluate(el => parseInt(el.textContent?.trim() || '1'));
        const totalPages = await totalPagesElement.evaluate(el => parseInt(el.textContent?.trim() || '1'));
        
        await this.logInfo(`Pagination info: Current page ${currentPage} of ${totalPages}`);
        return { currentPage, totalPages };
      }
      
      return null;
    } catch (error) {
      await this.logInfo(`No pagination found or error reading pagination info: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return null;
    }
  }

  async goToNextPage(): Promise<boolean> {
    return await SelectorUtils.findAndClick(this.page!, [BOOKING_SELECTORS.pagination.nextPageButton]);
  }

  async goToPreviousPage(): Promise<boolean> {
    return await SelectorUtils.findAndClick(this.page!, [BOOKING_SELECTORS.pagination.previousPageButton]);
  }

  async goToPage(pageNumber: number): Promise<boolean> {
    if (!this.page) throw new Error('Page not initialized');

    try {
      await this.logInfo(`Attempting to navigate to page ${pageNumber}`);
      
      // Try to find and click the specific page number
      const pageSelector = `${BOOKING_SELECTORS.pagination.pageNumbers}[data-page="${pageNumber}"]`;
      const pageElement = await this.page.$(pageSelector);
      
      if (pageElement) {
        await pageElement.click();
        await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
        await this.logInfo(`Successfully navigated to page ${pageNumber}`);
        return true;
      }
      
      await this.logInfo(`Page ${pageNumber} not found, using next/previous navigation`);
      return false;
    } catch (error) {
      await this.logInfo(`Error navigating to page ${pageNumber}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false;
    }
  }

  async getReservationRows(): Promise<string[]> {
    if (!this.page) throw new Error('Page not initialized');

    try {
      await this.logInfo('Getting reservation rows from current page...');
      
      // Wait for the table to load
      await this.page.waitForSelector(BOOKING_SELECTORS.reservations.reservationRow, { timeout: 10000 });
      
      // Get all reservation IDs from the current page
      const reservationIds = await this.page.evaluate((selectors) => {
        const rows = document.querySelectorAll(selectors.reservationRow);
        const ids: string[] = [];
        
        rows.forEach((row) => {
          const idElement = row.querySelector(selectors.reservationId);
          if (idElement) {
            const href = idElement.getAttribute('href');
            if (href) {
              // Extract reservation ID from href
              const match = href.match(/res_id=(\d+)/);
              if (match) {
                ids.push(match[1]);
              }
            }
          }
        });
        
        return ids;
      }, BOOKING_SELECTORS.reservations);

      await this.logInfo(`Found ${reservationIds.length} reservations on current page`);
      return reservationIds;

    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(BookingErrorType.DOM_NOT_FOUND)}`,
        {
          errorType: BookingErrorType.DOM_NOT_FOUND,
          error: error,
          phase: BookingScrapingPhase.NAVIGATION,
          platform: 'booking',
          action: 'get_reservation_rows',
          selector: BOOKING_SELECTORS.reservations.reservationRow
        }
      );
      return [];
    }
  }

  async getReservationData(): Promise<Array<{
    id: string;
    chargeBefore: string;
    amount: string;
    cardholder: string;
  }>> {
    if (!this.page) throw new Error('Page not initialized');

    try {
      await this.logInfo('Extracting reservation data from current page...');
      
      const reservationData = await this.page.evaluate(() => {
        const rows = document.querySelectorAll(BOOKING_SELECTORS.reservations.reservationRow);
        const data: Array<{
          id: string;
          chargeBefore: string;
          amount: string;
          cardholder: string;
        }> = [];
        
        rows.forEach((row) => {
          const idElement = row.querySelector(BOOKING_SELECTORS.reservations.reservationId);
          const chargeBeforeElement = row.querySelector(BOOKING_SELECTORS.reservations.reservationChargeBefore);
          const amountElement = row.querySelector(BOOKING_SELECTORS.reservations.reservationAmount);
          const cardholderElement = row.querySelector(BOOKING_SELECTORS.reservations.reservationCardholder);
          
          if (idElement) {
            const href = idElement.getAttribute('href');
            if (href) {
              const match = href.match(/res_id=(\d+)/);
              if (match) {
                data.push({
                  id: match[1],
                  chargeBefore: chargeBeforeElement?.textContent?.trim() || '',
                  amount: amountElement?.textContent?.trim() || '',
                  cardholder: cardholderElement?.textContent?.trim() || ''
                });
              }
            }
          }
        });
        
        return data;
      });

      await this.logInfo(`Extracted data for ${reservationData.length} reservations`);
      return reservationData;

    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(BookingErrorType.DOM_NOT_FOUND)}`,
        {
          errorType: BookingErrorType.DOM_NOT_FOUND,
          error: error,
          phase: BookingScrapingPhase.NAVIGATION,
          platform: 'booking',
          action: 'get_reservation_data'
        }
      );
      return [];
    }
  }

  async clickReservationDetail(reservationId: string, jobId?: string, propertyId?: string): Promise<boolean> {
    if (!this.page) throw new Error('Page not initialized');

    try {
      await this.logInfo(`Attempting to open reservation detail for ID: ${reservationId}`);

      // Listen for new page creation for reservation view
      const newPagePromise = new Promise<Page>((resolve) => {
        this.browser!.once('targetcreated', async (target) => {
          if (target.type() === 'page') {
            const newPage = await target.page();
            await newPage!.bringToFront();
            resolve(newPage!);
          }
        });
      });

      // Click the reservation link
      const reservationLink = await this.page.$(`a[href*="res_id=${reservationId}"]`);
      if (!reservationLink) {
        throw new Error(`Reservation link with ID ${reservationId} not found`);
      }
      await reservationLink.click();

      const newPage = await newPagePromise;
      
      // Check on captcha
      let captchaHandled = await this.handleCaptcha({
        type: 'browserless_ui',
        sessionUrl: this.sessionUrl,
        timeout: 180000,
        page: newPage
      });
  
      if (!captchaHandled) {
        await this.logInfo('Captcha not solved in new tab');
        return false;
      }

      // Check on 2fa
      const twoFASuccess = await this.handle2FA({ page: newPage });

      if (!twoFASuccess) {
        await this.logInfo('2FA not solved in new tab');
        return false;
      }

      // Check on captcha
      captchaHandled = await this.handleCaptcha({
        type: 'browserless_ui',
        sessionUrl: this.sessionUrl,
        timeout: 180000,
        page: newPage
      });
  
      if (!captchaHandled) {
        await this.logInfo('Captcha not solved in new tab');
        return false;
      }
      
      try {
        await newPage.waitForSelector(BOOKING_SELECTORS.reservations.reservationName, { timeout: 15000 });
        this.logInfo('Reservation detail page loaded successfully.');
      } catch (error) {
        await dualLogError(
          `[${new Date().toISOString()}] ${getBookingErrorDescription(BookingErrorType.RESERVATION_NOT_FOUND)}`,
          {
            errorType: BookingErrorType.RESERVATION_NOT_FOUND,
            error: error,
            phase: BookingScrapingPhase.NAVIGATION,
            platform: 'booking',
            action: 'click_reservation_detail',
          }
        );
        await this.takeScreenshot(`reservation-detail-failure.png`);
        throw new Error('Reservation detail page did not load as expected.');
      }
      
      // Process reservation details in the new tab
      const originalPage = this.page;
      this.page = newPage;
      
      try {
        const success = await this.processReservationDetail(reservationId);
        if (!success) {
          await this.logInfo(`Failed to process reservation detail for ${reservationId}`);
        }
      } finally {
        // Restore original page
        this.page = originalPage;
      }
      
      // Close the new tab and switch back
      await newPage.close();
      await this.logInfo(`Closed reservation detail tab`);
      
      return true;
    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(BookingErrorType.DOM_NOT_FOUND)}`,
        {
          errorType: BookingErrorType.DOM_NOT_FOUND,
          error: error,
          phase: BookingScrapingPhase.NAVIGATION,
          platform: 'booking',
          reservationId: reservationId,
          action: 'click_reservation_detail'
        }
      );
      return false;
    }
  }

  async traverseAllReservations(options: {
    maxPages?: number;
    timeoutMinutes?: number;
    stopOnLastPage?: boolean;
    jobId?: string;
    propertyId?: string;
  } = {}): Promise<{ processed: number; errors: number }> {
    if (!this.page) throw new Error('Page not initialized');

    let processedCount = 0;
    let errorCount = 0;
    const startTime = Date.now();

    try {
      // Get pagination info
      await this.logInfo('Getting pagination information...');
      const paginationInfo = await this.getPaginationInfo();
      
      const totalPages = paginationInfo ? paginationInfo.totalPages : 1;
      const maxPagesToProcess = options.maxPages ? Math.min(options.maxPages, totalPages) : totalPages;
      
      await this.logInfo(`Starting reservation traversal: ${totalPages} total pages available, processing up to ${maxPagesToProcess} pages`);

      // Process each page
      for (let currentPage = 1; currentPage <= maxPagesToProcess; currentPage++) {
        // Check timeout
        if (this.isTimeoutReached(startTime, options.timeoutMinutes)) {
          await this.logInfo(`Timeout reached (${options.timeoutMinutes || 60} minutes), stopping traversal`);
          break;
        }

        const pageResult = await this.processPage(currentPage, totalPages, {
          stopOnLastPage: options.stopOnLastPage,
          jobId: options.jobId,
          propertyId: options.propertyId
        });
        processedCount += pageResult.processed;
        errorCount += pageResult.errors;

        // Navigate to next page (except for the last page)
        if (currentPage < maxPagesToProcess) {
          const navigationSuccess = await this.navigateToNextPage();
          if (!navigationSuccess) {
            await this.logInfo('No next page available, stopping traversal');
            break;
          }
        }
      }

      await this.logInfo(`Reservation traversal completed. Processed: ${processedCount}, Errors: ${errorCount}`);
      return { processed: processedCount, errors: errorCount };

    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(BookingErrorType.UNKNOWN)}`,
        {
          errorType: BookingErrorType.UNKNOWN,
          error: error,
          phase: BookingScrapingPhase.NAVIGATION,
          platform: 'booking',
          action: 'traverse_all_reservations',
          processedCount,
          errorCount
        }
      );
      return { processed: processedCount, errors: errorCount };
    }
  }





  private async processPage(currentPage: number, totalPages: number, options: { 
    stopOnLastPage?: boolean;
    jobId?: string;
    propertyId?: string;
  }): Promise<{ processed: number; errors: number }> {
    await this.logInfo(`Processing page ${currentPage}/${totalPages}`);

    // Get and process reservations
    const reservationIds = await this.getReservationRows();
    
    if (reservationIds.length === 0) {
      await this.logInfo('No reservations found on current page');
      if (options.stopOnLastPage) {
        await this.logInfo('Stopping traversal due to empty page');
        return { processed: 0, errors: 0 };
      }
    }

    return await this.processReservations(reservationIds, options.jobId, options.propertyId);
  }

  private async processReservations(reservationIds: string[], jobId?: string, propertyId?: string): Promise<{ processed: number; errors: number }> {
    let processedCount = 0;
    let errorCount = 0;

    for (const reservationId of reservationIds) {
      try {
        const success = await this.clickReservationDetail(reservationId, jobId, propertyId);
        if (success) {
          processedCount++;
          await this.logInfo(`Successfully processed reservation ${reservationId} (${processedCount} total)`);
        } else {
          errorCount++;
          await this.logInfo(`Failed to process reservation ${reservationId}`);
        }
      } catch (error) {
        errorCount++;
        await this.logInfo(`Error processing reservation ${reservationId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return { processed: processedCount, errors: errorCount };
  }

  private isTimeoutReached(startTime: number, timeoutMinutes?: number): boolean {
    const timeoutMs = (timeoutMinutes || 60) * 60 * 1000;
    return Date.now() - startTime > timeoutMs;
  }

  private async navigateToNextPage(): Promise<boolean> {
    const nextPageSuccess = await this.goToNextPage();
    if (nextPageSuccess) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return nextPageSuccess;
  }

  private async expandMainMenu(mainSection: string): Promise<boolean> {
    const mainMenuSelectors = BOOKING_SELECTORS.navigation.mainMenu(mainSection);
    return SelectorUtils.findAndClick(this.page!, mainMenuSelectors);
  }

  private async clickSubMenu(subSection: string): Promise<boolean> {
    // Submenu time to render
    await new Promise(resolve => setTimeout(resolve, 1000));
    const subMenuSelectors = BOOKING_SELECTORS.navigation.subMenu(subSection);
    const clicked = await SelectorUtils.findAndClick(this.page!, subMenuSelectors);

    if (!clicked) {
      // Fallback: try to find by visible text
      const textFound = await this.page!.evaluate((text) => {
        const links = Array.from(document.querySelectorAll('a[data-tid="item-link"]'));
        for (const link of links) {
          if (link.textContent && link.textContent.toLowerCase().includes(text.toLowerCase())) {
            (link as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, subSection.replace(/_/g, ' '));
      return !!textFound;
    }
    return true;
  }

  private async waitForNavigationAndVerify(expectedUrl: string): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');
    await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {
      this.logInfo('Navigation timeout after vccs management page');
    });
    
    const currentUrl = this.page!.url();
    if (!currentUrl.includes(expectedUrl)) {
      throw new Error(`Navigation failed - expected ${expectedUrl}, got: ${currentUrl}`);
    }
  }

  async navigateToMenuSection(mainSection: string, subSection: string, expectedUrl: string): Promise<boolean> {
    if (!this.page) throw new Error('Page not initialized');
    try {
      await this.logInfo(`Navigating to ${subSection} page`);
      const mainMenuClicked = await this.expandMainMenu(mainSection);
      if (!mainMenuClicked) {
        await this.logError(`${mainSection} menu button not found`);
        await this.takeScreenshot(`booking-${mainSection}-menu-not-found.png`);
        throw new Error(`${mainSection} menu button not found`);
      }
      
      await this.logInfo(`${mainSection} menu expanded`);
      const subMenuClicked = await this.clickSubMenu(subSection);

      if (!subMenuClicked) {
        await this.logError(`${subSection} link not found by any selector or text`);
        await this.takeScreenshot(`booking-${subSection}-link-not-found.png`);
        throw new Error(`${subSection} link not found by any selector or text`);
      }
      
      await this.logInfo(`Clicked on ${subSection} link`);
      await this.waitForNavigationAndVerify(expectedUrl);
      await this.logInfo(`Successfully navigated to ${subSection} page`);
      await this.takeScreenshot(`booking-${subSection}-page.png`);
      return true;
    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(BookingErrorType.DOM_NOT_FOUND)}`,
        {
          errorType: BookingErrorType.DOM_NOT_FOUND,
          error: error,
          phase: BookingScrapingPhase.NAVIGATION,
          platform: 'booking',
          targetPage: subSection,
          mainSection: mainSection
        }
      );
      await this.takeScreenshot('booking-navigation-error.png');
      return false;
    }
  }

  async scrapeData(params: ScrapingJobParams): Promise<ScrapingResult> {
    try {
      await this.logInfo('Starting complete Booking.com scraping process', this.page?.url());
      
      // Step 1: Navigate to VCCS Management
      const navigationSuccess = await this.navigateToMenuSection('finance', 'vccs_management', 'vccs_management');
      
      if (!navigationSuccess) {
        throw new Error('Failed to navigate to VCCS Management page');
      }
      
      await this.logInfo('Successfully reached VCCS Management page');
      
      // Step 2: Click "View all" button to access VCCS to charge
      await this.logInfo('Clicking "View all" button...');
      const viewAllSuccess = await this.clickViewAllVccsToCharge();
      
      if (!viewAllSuccess) {
        throw new Error('Failed to click "View all" button or navigate to VCCS to charge page');
      }
      
      await this.logInfo('Successfully navigated to VCCS to charge page');
      
      // Step 3: Traverse all reservations
      await this.logInfo('Starting reservation traversal...');
      
      // Optional params
      const traversalOptions = {
        jobId: params.jobId,
        propertyId: params.propertyId
      };
      
      await this.logInfo(`Starting reservation traversal with options:`, traversalOptions);
      
      const traversalResult = await this.traverseAllReservations(traversalOptions);
      
      await this.logInfo('Traversal Results:');
      await this.logInfo(`Successfully processed: ${traversalResult.processed} reservations`);
      await this.logInfo(`Errors encountered: ${traversalResult.errors}`);
      
      // Step 4: Take final screenshot
      await this.takeScreenshot('booking-scraping-complete.png');
      
      // Prepare the result data
      const data = {
        platform: 'booking',
        timestamp: new Date().toISOString(),
        jobId: params.jobId,
        propertyId: params.propertyId,
        navigation: {
          vccsManagement: navigationSuccess,
          viewAllButton: viewAllSuccess
        },
        traversal: {
          processed: traversalResult.processed,
          errors: traversalResult.errors,
          options: traversalOptions
        }
      };
      
      await this.logInfo('Booking.com scraping completed successfully');
      
      return {
        success: true,
        data,
      };
      
    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(BookingErrorType.UNKNOWN)}`,
        {
          errorType: BookingErrorType.UNKNOWN,
          error: error,
          phase: BookingScrapingPhase.NAVIGATION,
          jobId: params.jobId,
          propertyId: params.propertyId,
          platform: 'booking',
          action: 'scrape_data'
        }
      );
      
      await this.takeScreenshot(`booking-scraping-error-${Date.now()}.png`);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Scraping failed',
        screenshots: [`booking-scraping-error-${Date.now()}.png`]
      };
    }
  }

  async cleanup(): Promise<void> {
    try {
      if (this.browser) {
        await this.browser.close();
        await this.logInfo('Browser closed successfully');
      }
    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(BookingErrorType.UNKNOWN)}`,
        {
          errorType: BookingErrorType.UNKNOWN,
          error: error,
          phase: BookingScrapingPhase.NAVIGATION,
          platform: 'booking',
          action: 'cleanup'
        }
      );
    }
  }

  private async createBrowserlessSession(): Promise<any> {
    try {
      await this.logInfo('Creating Browserless session with UI access');

      const sessionConfig = {
        ttl: 180000, // 3 minutes
        stealth: true,
        headless: false,
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--enable-javascript",
          "--disable-web-security"
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
  
      await this.logInfo(`Response status: ${response.status} ${response.statusText}`);
  
      if (!response.ok) {
        const errorText = await response.text();
        await this.logError(`Failed to create session: ${response.status} "${errorText}"`);
        return null;
      }
  
      const session = await response.json() as any;
  
      await this.logInfo('Browserless session created successfully', {
        sessionId: session.id,
        browserWSEndpoint: session.connect
      });
  
      return session;
  
    } catch (error) {
      await this.logError('Session creation failed', error);
      return null;
    }
  }
  private async solveCaptchaAutomatically(): Promise<boolean> {
    if (!this.page) return false;

    try {
      await this.logInfo('Attempting automatic captcha solution');
      
      // Wait for captcha images to load
      await this.page.waitForSelector('img', { timeout: 10000 });
      await this.delay(2000);
      
      // Get all images and click on potential clock images
      const images = await this.page.$$('img');
      await this.logInfo(`Found ${images.length} images to analyze`);
      
      let clocksFound = 0;
      for (let i = 0; i < images.length; i++) {
        try {
          const imgElement = images[i];
          const box = await imgElement.boundingBox();
          if (box && box.width > 50 && box.height > 50) {
            await this.logInfo(`Clicking image ${i + 1}`);
            await imgElement.click();
            clocksFound++;
            await this.delay(500);
          }
        } catch (e) {
          // Skip images that can't be clicked
        }
      }
      
      await this.logInfo(`Clicked ${clocksFound} potential clock images`);
      
      // Look for and click Confirm button
      const confirmSelectors = ['button:contains("Confirm")', 'input[value="Confirm"]', 'button[type="submit"]'];
      
      for (const selector of confirmSelectors) {
        try {
          if (selector.includes('contains')) {
            const elements = await this.page.evaluate(() => {
              const buttons = Array.from(document.querySelectorAll('button'));
              return buttons.find(btn => btn.textContent?.includes('Confirm'));
            });
            if (elements) {
              await this.logInfo('Clicking Confirm button');
              await this.page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const confirmBtn = buttons.find(btn => btn.textContent?.includes('Confirm'));
                if (confirmBtn) confirmBtn.click();
              });
              break;
            }
          } else {
            const confirmBtn = await this.page.$(selector);
            if (confirmBtn) {
              await this.logInfo(`Clicking Confirm: ${selector}`);
              await confirmBtn.click();
              break;
            }
          }
        } catch (e) {
          // Try next selector
        }
      }
      
      await this.delay(3000);
      
      // Check if captcha is solved
      const pageContent = await this.page.content();
      const stillHasCaptcha = pageContent.includes("Let's make sure you're human") || 
                             pageContent.includes("Choose all the clocks");
      
      if (!stillHasCaptcha) {
        await this.logInfo('Captcha appears to be solved automatically');
        return true;
      } else {
        await this.logInfo('Automatic captcha solution may have failed');
        return false;
      }
    } catch (error) {
      await this.logError('Automatic captcha solution failed', error);
      return false;
    }
  }

  private async solveCaptchaWithUI(sessionUrl: string, timeout: number): Promise<boolean> {
    await this.logInfo('Manual captcha solving required');
    await this.logInfo(`Open this URL to solve captcha: ${sessionUrl}`);
    await this.logInfo('Solve the captcha in the Browserless UI and press Enter');
    
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      const timer = setTimeout(() => {
        rl.close();
        this.logError('Captcha timeout');
        resolve(false);
      }, timeout);
      
      rl.question('Press Enter after solving the captcha: ', () => {
        clearTimeout(timer);
        rl.close();
        resolve(true);
      });
    });
  }

  private async solveCaptchaManually(timeout: number): Promise<boolean> {
    await this.logInfo('Manual captcha intervention required');
    
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      const timer = setTimeout(() => {
        rl.close();
        this.logError('Captcha timeout');
        resolve(false);
      }, timeout);
      
      rl.question('Captcha detected! Solve it and press Enter: ', () => {
        clearTimeout(timer);
        rl.close();
        resolve(true);
      });
    });
  }

  private async prompt2FA(timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      const timer = setTimeout(() => {
        rl.close();
        reject(new Error('2FA timeout'));
      }, timeout);
      
      rl.question('Enter 2FA code (6 digits): ', (code) => {
        clearTimeout(timer);
        rl.close();
        resolve(code);
      });
    });
  }

  private async enterEmail(email: string): Promise<boolean> {
    return await SelectorUtils.findAndType(this.page!, [...BOOKING_SELECTORS.email], email);
  }

  private async enterPassword(password: string): Promise<boolean> {
    return await SelectorUtils.findAndType(this.page!, [...BOOKING_SELECTORS.password], password);
  }

  private async clickLoginButton(): Promise<boolean> {
    return await SelectorUtils.findAndClick(this.page!, [...BOOKING_SELECTORS.loginButton]);
  }

  private async clickContinueButton(): Promise<boolean> {
    return await SelectorUtils.findAndClick(this.page!, [...BOOKING_SELECTORS.continueButton]);
  }

  private async checkLoginErrors(): Promise<void> {
    try {
      // Wait for any error messages to appear
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Check for error messages
      const hasError = await SelectorUtils.trySelectors(
        this.page!,
        [...BOOKING_SELECTORS.errorMessages],
        async (selector: string) => {
          const element = await this.page!.$(selector);
          if (element) {
            const errorText = await element.evaluate(el => el.textContent?.trim());
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
                  platform: 'booking'
                }
              );
              
              await this.takeScreenshot('booking-login-error.png');
              return true;
            }
          }
          return false;
        },
        5000 // 5 second timeout
      );

      if (hasError) {
        throw new Error('Login failed - error message detected');
      }

      await this.logInfo('Login error check passed - no errors detected');

    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(BookingErrorType.UNKNOWN)}`,
        {
          errorType: BookingErrorType.UNKNOWN,
          error: error,
          phase: BookingScrapingPhase.LOGIN,
          platform: 'booking'
        }
      );
      throw error;
    }
  }

  // Method to determine error type from error text
  private determineLoginErrorType(errorText: string): BookingErrorType {
    const lowerErrorText = errorText.toLowerCase();
    
    // Authentication errors
    if (lowerErrorText.includes("don't match") || 
        lowerErrorText.includes("incorrect") || 
        lowerErrorText.includes("invalid credentials")) {
      return BookingErrorType.AUTHENTICATION_ERROR;
    }
    
    // Account locked/blocked
    if (lowerErrorText.includes("locked") || 
        lowerErrorText.includes("blocked") || 
        lowerErrorText.includes("suspended")) {
      return BookingErrorType.BLOCKED;
    }
    
    // Rate limiting
    if (lowerErrorText.includes("too many") || 
        lowerErrorText.includes("rate limit") || 
        lowerErrorText.includes("try again later")) {
      return BookingErrorType.RATE_LIMITED;
    }
    
    // CAPTCHA
    if (lowerErrorText.includes("captcha") || 
        lowerErrorText.includes("verify") || 
        lowerErrorText.includes("robot")) {
      return BookingErrorType.CAPTCHA;
    }
    
    // Network/connection issues
    if (lowerErrorText.includes("connection") || 
        lowerErrorText.includes("network") || 
        lowerErrorText.includes("timeout")) {
      return BookingErrorType.NETWORK_ERROR;
    }
    
    // Default to login failed for other cases
    return BookingErrorType.LOGIN_FAILED;
  }

  async extractReservationDetails(reservationId: string): Promise<{
    basicData: any;
    // paymentData: any;
    cardData: any;
  } | null> {
    if (!this.page) throw new Error('Page not initialized');

    try {
      await this.logInfo(`Extracting details for reservation ${reservationId}`);

      // Extract basic reservation data from the current page
      const basicData = await this.extractBasicReservationData();
      
      // Extract payment information
      // const paymentData = await this.extractPaymentData();
      
      // Extract credit card details (requires additional navigation)
      const cardData = await this.extractCreditCardDetails(reservationId);

      return {
        basicData,
        // paymentData,
        cardData
      };

    } catch (error) {
      await this.logError(`Failed to extract reservation details for ${reservationId}`, error);
      return null;
    }
  }

  private async extractBasicReservationData(): Promise<any> {
    if (!this.page) throw new Error('Page not initialized');
  
    try {
      const basicData = await this.page.evaluate(() => {
        const result: Record<string, string> = {
          guestName: '',
          checkInDate: '',
          checkOutDate: '',
          bookingAmount: '',
          reservationId: '',
          bookedDate: '',
          commissionAmount: '',
          roomType: '',
          reservationStatus: ''
        };
  
        const labelMap: Record<string, keyof typeof result> = {
          'Guest name:': 'guestName',
          'Check-in': 'checkInDate',
          'Check-out': 'checkOutDate',
          'Total price': 'bookingAmount',
          'Booking number:': 'reservationId',
          'Received': 'bookedDate',
          'Commissionable amount:': 'commissionAmount'
        };
  
        // Extract all label elements
        const labels = document.querySelectorAll('.res-content__label');
        labels.forEach((labelEl) => {
          const labelText = labelEl.textContent?.trim();
          const mappedKey = labelMap[labelText as keyof typeof labelMap];
          if (mappedKey) {
            const valueEl = labelEl.nextElementSibling;
            const value = valueEl?.textContent?.trim() || '';
            result[mappedKey] = value;
          }
        });
  
        // Room type and guest name might be outside label structure
        const guestEl = document.querySelector('[data-test-id="reservation-overview-name"]');
        if (guestEl) result.guestName = guestEl.textContent?.trim() || result.guestName;
  
        const roomTypeEl = document.querySelector('.res-room-title__name');
        if (roomTypeEl) result.roomType = roomTypeEl.textContent?.trim() || result.roomType;
        
        const statusEl = document.querySelector('.res-view-cc__badge span span');
        if (statusEl) result.reservationStatus = statusEl.textContent?.trim() || '';

        return result;
      });
  
      await this.logInfo('Extracted basic reservation data', basicData);
      return basicData;
  
    } catch (error) {
      await this.logError('Failed to extract basic reservation data', error);
      return null;
    }
  }

  private async extractPaymentData(): Promise<any> {
    try {
      const paymentData = await this.page!.evaluate(() => {
        // Extract payment status
        const paymentStatusElement = document.querySelector('.res-content__info');
        const paymentStatus = paymentStatusElement?.textContent?.trim() || '';

        // Extract virtual card balance
        const balanceElement = document.querySelector('.bui-price-display__value');
        const virtualCardBalance = balanceElement?.textContent?.trim() || '';

        // Extract commission
        const commissionElement = document.querySelector('.res-content__info');
        const commission = commissionElement?.textContent?.trim() || '';

        return {
          paymentStatus,
          virtualCardBalance,
          commission,
          total_guest_payment: 0,
          cancellation_fee: 0,
          total_payout: 0,
          amount_to_charge_or_refund: 0
        };
      });

      await this.logInfo('Extracted payment data', paymentData);
      return paymentData;

    } catch (error) {
      await this.logError('Failed to extract payment data', error);
      return {
        paymentStatus: '',
        virtualCardBalance: '',
        commission: '',
        total_guest_payment: 0,
        cancellation_fee: 0,
        total_payout: 0,
        amount_to_charge_or_refund: 0
      };
    }
  }

  private async extractCreditCardDetails(reservationId: string): Promise<any> {
    try {
      await this.logInfo(`Extracting credit card details for reservation ${reservationId}`);

      // Click "View credit card details" button
      const viewCardButton = await this.page!.$('button.bui-button--primary');
      if (!viewCardButton) {
        await this.logInfo('View credit card details button not found');
        return null;
      }

      await viewCardButton.click();
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Wait for popup/modal to appear
      const popupSelector = '.bui-modal__content';
      await this.page!.waitForSelector(popupSelector, { timeout: 10000 });

      // Click "Sign in to view credit card details" link
      const signInLink = await this.page!.$('a[href*="oauth2/authorize"]');
      if (!signInLink) {
        await this.logInfo('Sign in link not found in popup');
        return null;
      }

      // Get the href attribute to open in new tab
      const signInUrl = await signInLink.evaluate(el => el.getAttribute('href'));
      
      // Open new tab for credit card details
      const newPage = await this.browser!.newPage();
      await newPage.goto(signInUrl!);
      
      // Handle login in new tab if needed
      await this.handleLoginInNewTab(newPage);
      
      // Extract credit card details
      const cardData = await this.extractCardDetailsFromPage(newPage);
      
      // Close the new tab
      await newPage.close();

      return cardData;

    } catch (error) {
      await this.logError('Failed to extract credit card details', error);
      return null;
    }
  }

  private async handleLoginInNewTab(page: Page): Promise<void> {
    try {
      // Check if we need to login
      const loginForm = await page.$('form[action*="authenticate.html"]');
      if (loginForm) {
        await this.logInfo('Login required in credit card details page');
        
        // Enter credentials
        await page.type('input[name="username"]', process.env.BOOKING_EMAIL || '');
        await page.type('input[name="password"]', process.env.BOOKING_PASSWORD || '');
        
        // Submit form
        await page.click('button[type="submit"]');
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
      }
    } catch (error) {
      await this.logError('Failed to handle login in new tab', error);
    }
  }

  private async extractCardDetailsFromPage(page: Page): Promise<any> {
    try {
      const cardData = await page.evaluate(() => {
        // Extract card details from the table
        const rows = document.querySelectorAll('table tbody tr');
        const cardInfo: any = {};

        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 2) {
            const label = cells[0]?.textContent?.trim();
            const value = cells[1]?.textContent?.trim();

            if (label && value) {
              switch (label.toLowerCase()) {
                case 'available balance:':
                  cardInfo.available_balance = value;
                  break;
                case 'card type:':
                  cardInfo.card_type = value;
                  break;
                case 'card number:':
                  cardInfo.card_number = value;
                  break;
                case 'card holder\'s name:':
                  cardInfo.card_holder = value;
                  break;
                case 'expiration date:':
                  cardInfo.expiration_date = value;
                  break;
                case 'cvc code:':
                  cardInfo.cvc_code = value;
                  break;
              }
            }
          }
        }

        return cardInfo;
      });

      await this.logInfo('Extracted card details', cardData);
      return cardData;

    } catch (error) {
      await this.logError('Failed to extract card details from page', error);
      return null;
    }
  }

  async saveReservationToDatabase(
    jobId: string,
    propertyId: string,
    basicData: any,
    // paymentData: any,
    cardData: any
  ): Promise<any> {
    try {
      // Validate inputs
      if (!jobId || !propertyId) {
        throw new Error('JobId and PropertyId are required');
      }

      // Parse dates
      const parseDate = (dateStr: string): Date => {
        if (!dateStr) return new Date();
        
        // Handle different date formats
        if (dateStr.includes('/')) {
          // Format: MM/DD/YYYY
          return new Date(dateStr);
        } else if (dateStr.includes('-')) {
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
        const cleaned = amountStr.replace(/[^\d.-]/g, '');
        const amount = parseFloat(cleaned);
        return isNaN(amount) ? 0 : -Math.abs(amount); // Negative for charges
      };

      const jobItemData = {
        job_id: jobId,
        property_id: propertyId,
        guest_name: basicData.guestName || 'Unknown Guest',
        reservation_id: basicData.bookingNumber || '',
        confirmation_number: basicData.bookingNumber || '', // Use booking number as confirmation
        check_in_date: parseDate(basicData.checkInDate),
        check_out_date: parseDate(basicData.checkOutDate),
        room_type: basicData.roomType || 'Unknown',
        booking_amount: parseAmount(basicData.totalPrice),
        booked_date: parseDate(basicData.receivedDate),
        has_card_info: !!cardData,
        // has_payment_info: !!paymentData,
        // payment_info: paymentData || undefined,
        card_info: cardData || undefined,
        reservation_status: basicData.reservationStatus,
        additional_text: basicData.commissionAmount || undefined
      };

      // Import jobService dynamically to avoid circular dependencies
      const { jobService } = await import('../services/job.service.js');
      const savedItem = await jobService.createJobItem(jobItemData);
      
      await this.logInfo(`Saved reservation ${basicData.bookingNumber} to database`);
      return savedItem;

    } catch (error) {
      await this.logError(`Failed to save reservation to database:`, error);
      return null;
    }
  }

  async processReservationDetail(reservationId: string, jobId?: string, propertyId?: string): Promise<boolean> {
    try {
      await this.logInfo(`Processing reservation detail: ${reservationId}`);

      // Extract all reservation data
      const extractionResult = await this.extractReservationDetails(reservationId);
      
      if (!extractionResult) {
        await this.logError(`Failed to extract data for reservation ${reservationId}`);
        return false;
      }

      const { basicData, /*paymentData,*/ cardData } = extractionResult;

      // Save to database if jobId and propertyId are provided
      if (jobId && propertyId) {
        await this.saveReservationToDatabase(jobId, propertyId, basicData, /*paymentData,*/ cardData);
      }

      await this.logInfo(`Successfully processed reservation ${reservationId}`);
      return true;

    } catch (error) {
      await this.logError(`Error processing reservation ${reservationId}:`, error);
      return false;
    }
  }
}