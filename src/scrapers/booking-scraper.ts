import puppeteer, { Browser, Page } from "puppeteer";
import fs from 'fs';
import readline from 'readline';
import fetch from 'node-fetch';
import { BaseScraper, LoginCredentials, CaptchaHandlerOptions, TwoFactorAuthOptions, ScrapingJobParams, ScrapingResult } from "./base-scraper.js";
import { timeoutManager } from "../common/timeout-manager.js";
import handleBookingOtpVerification from "../otp-verification/booking-otp-verification.js";
import { SelectorUtils } from "../common/selector-utils.js";
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

  // Keep selectors in booking-scraper as exportable const
  public static readonly SELECTORS = {
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
    ]
  } as const;

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
        console.log("Live URL generation failed - will use session URL instead");
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

  async login(credentials: LoginCredentials): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');

    try {
      // Check if already logged in
      const currentUrl = this.page.url();
      if ((currentUrl.includes('admin.booking.com') || currentUrl.includes('account.business.booking.com')) && !currentUrl.includes('sign-in')) {
        await this.logInfo('Already logged in');
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
        for (const selector of BookingScraper.SELECTORS.password) {
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

      // Save cookies on successful login
      const finalUrl = this.page.url();
      if ((finalUrl.includes('admin.booking.com') || finalUrl.includes('account.business.booking.com') || finalUrl.includes('partner')) && !finalUrl.includes('sign-in')) {
        await this.logInfo('Login successful');
        const cookies = await this.page.cookies();
        fs.writeFileSync(this.cookiesFile, JSON.stringify(cookies, null, 2));
        await this.logInfo(`Saved ${cookies.length} cookies for future sessions`);
        await this.takeScreenshot('booking-admin-dashboard.png');
      } else {
        await this.logInfo('Login requires 2FA verification', { currentUrl: finalUrl });
        
        // Try to handle 2FA automatically
        const twoFASuccess = await this.handle2FA();
        if (twoFASuccess) {
          await this.logInfo('2FA completed successfully');
          // Save cookies after successful 2FA
          const cookies = await this.page.cookies();
          fs.writeFileSync(this.cookiesFile, JSON.stringify(cookies, null, 2));
          await this.logInfo(`Saved ${cookies.length} cookies after 2FA`);
          await this.takeScreenshot('booking-admin-dashboard-after-2fa.png');
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

  async handleCaptcha(options?: CaptchaHandlerOptions): Promise<boolean> {
    if (!this.page) return false;

    try {
      const pageContent = await this.page.content();
      const hasCaptcha = pageContent.includes("Let's make sure you're human") || 
                        pageContent.includes("Choose all the clocks") ||
                        (pageContent.includes("Confirm") && pageContent.includes("clocks"));

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
    if (!this.page || !this.browser) return false;

    try {
      const currentUrl = this.page.url();
      
      // Check if we're on a verification-related page
      const needsVerification = currentUrl.includes('2fa') || 
                               currentUrl.includes('verify') || 
                               currentUrl.includes('authentication') ||
                               currentUrl.includes('sign-in/verification') ||
                               currentUrl.includes('select-phone');

      if (!needsVerification) {
        // Also check page content for verification indicators
        const pageContent = await this.page.content();
        const hasVerificationContent = pageContent.includes('Verification method') ||
                                     pageContent.includes('nw-signin-verification') ||
                                     pageContent.includes('verification-pulse-link') ||
                                     pageContent.includes('sms-verification-link');
        
        if (!hasVerificationContent) {
          await this.logInfo('No 2FA required');
          return true;
        }
      }

      await this.logInfo('2FA verification required, using automated OTP handler');
      await this.takeScreenshot('booking-2fa-page.png');

      try {
        // Use the new automated OTP verification handler
        await handleBookingOtpVerification(this.browser, this.page);
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

        // Try to find OTP input field for manual entry
        for (const selector of BookingScraper.SELECTORS.tfaSelectors) {
          try {
            await this.page.waitForSelector(selector, { timeout: 10000 });
            await this.logInfo(`Found 2FA field for manual entry: ${selector}`);
            
            const code = await this.prompt2FA(options?.timeout || 120000);
            await this.page.type(selector, code, { delay: 100 });
            await this.page.keyboard.press('Enter');
            await this.logInfo('Manual 2FA code submitted');
            
            await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {
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

  async searchProperty(propertyId: string): Promise<boolean> {
    if (!this.page) throw new Error('Page not initialized');

    try {
      await this.logInfo('Searching for property', { propertyId });
      // TODO: Implement property search logic for Booking.com
      // This would depend on the specific admin panel structure
      await this.logInfo('Property search not yet implemented for Booking.com');
      return true;
    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(BookingErrorType.PROPERTY_NOT_FOUND)}`,
        {
          errorType: BookingErrorType.PROPERTY_NOT_FOUND,
          error: error,
          phase: BookingScrapingPhase.PROPERTY_SEARCH,
          propertyId,
          platform: 'booking'
        }
      );
      return false;
    }
  }

  async scrapeData(params: ScrapingJobParams): Promise<ScrapingResult> {
    try {
      await this.logInfo('Starting data scraping for Booking.com');
      
      // TODO: Implement actual scraping logic based on requirements
      // This is a placeholder implementation
      const data = {
        platform: 'booking',
        timestamp: new Date().toISOString(),
        jobId: params.jobId,
        propertyId: params.propertyId,
        // Add actual scraped data here
      };

      await this.takeScreenshot('booking-scraping-complete.png');
      
      return {
        success: true,
        data,
        screenshots: ['booking-scraping-complete.png']
      };
    } catch (error) {
      await dualLogError(
        `[${new Date().toISOString()}] ${getBookingErrorDescription(BookingErrorType.PRICE_NOT_FOUND)}`,
        {
          errorType: BookingErrorType.PRICE_NOT_FOUND,
          error: error,
          phase: BookingScrapingPhase.PRICE_EXTRACTION,
          jobId: params.jobId,
          propertyId: params.propertyId,
          platform: 'booking'
        }
      );
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
      await this.logError('Cleanup failed', error);
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
          "--disable-background-timer-throttling"
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
    return await SelectorUtils.findAndType(this.page!, [...BookingScraper.SELECTORS.email], email);
  }

  private async enterPassword(password: string): Promise<boolean> {
    return await SelectorUtils.findAndType(this.page!, [...BookingScraper.SELECTORS.password], password);
  }

  private async clickLoginButton(): Promise<boolean> {
    return await SelectorUtils.findAndClick(this.page!, [...BookingScraper.SELECTORS.loginButton]);
  }

  private async clickContinueButton(): Promise<boolean> {
    return await SelectorUtils.findAndClick(this.page!, [...BookingScraper.SELECTORS.continueButton]);
  }

  // Enhanced error check using booking error types
  private async checkLoginErrors(): Promise<void> {
    try {
      // Wait a bit for any error messages to appear
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Check for error messages using SelectorUtils.trySelectors
      const hasError = await SelectorUtils.trySelectors(
        this.page!,
        [...BookingScraper.SELECTORS.errorMessages],
        async (selector: string) => {
          const element = await this.page!.$(selector);
          if (element) {
            const errorText = await element.evaluate(el => el.textContent?.trim());
            if (errorText) {
              // Determine error type based on error text content
              const errorType = this.determineLoginErrorType(errorText);
              const errorDescription = getBookingErrorDescription(errorType);
              const shouldRetry = shouldRetryBookingError(errorType);
              
              // Log with proper error type and context
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

  // Helper method to determine error type from error text
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
}