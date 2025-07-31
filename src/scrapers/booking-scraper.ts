import puppeteer, { Browser, Page } from "puppeteer";
import fs from 'fs';
import readline from 'readline';
import fetch from 'node-fetch';
import { BaseScraper, LoginCredentials, CaptchaHandlerOptions, TwoFactorAuthOptions, ScrapingJobParams, ScrapingResult } from "./base-scraper.js";
import { timeoutManager } from "../common/timeout-manager.js";

export class BookingScraper extends BaseScraper {
  private cookiesFile = 'booking-admin-cookies.json';
  private browserlessToken: string;
  private sessionUrl?: string;

  constructor() {
    super('booking', 'https://account.booking.com/sign-in');
    this.browserlessToken = process.env.BROWSERLESS_TOKEN || '2SXlnLjeZpwR2tV6ab1698bfe680a3959c2c681f06939ee3b';
  }

  async setupBrowser(jobId?: string): Promise<{ browser: Browser; page: Page }> {
    try {
      await this.logInfo('Setting up Booking.com browser with Browserless');

      // Try to create a UI-accessible session
      const session = await this.createBrowserlessSession();
      if (session) {
        this.sessionUrl = `https://production-sfo.browserless.io/sessions/${session.id}`;
        await this.logInfo('Browserless UI session created', { sessionUrl: this.sessionUrl });
      }

      // Get timeout configuration
      const loadingTimeout = jobId ? await timeoutManager.getLoadingTimeout(jobId) : 120000;
      const selectorTimeout = jobId ? await timeoutManager.getSelectorTimeout(jobId) : 30000;

      // Connect to Browserless
      const browser = await puppeteer.connect({
        browserWSEndpoint: `wss://production-sfo.browserless.io/?token=${this.browserlessToken}&stealth=true`,
        protocolTimeout: 300000 // 5 minutes
      });

      const page = await browser.newPage();
      
      // Set viewport and timeouts
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setDefaultNavigationTimeout(loadingTimeout);
      await page.setDefaultTimeout(selectorTimeout);

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

      // Wait for email input and enter email
      await this.logInfo('Entering email address');
      const emailSelectors = [
        'input[name="username"]',
        '#username',
        'input[type="email"]',
        'input[placeholder*="email"]'
      ];

      let emailField = null;
      for (const selector of emailSelectors) {
        try {
          await this.page.waitForSelector(selector, { visible: true, timeout: 10000 });
          emailField = await this.page.$(selector);
          if (emailField) {
            await this.logInfo(`Email field found: ${selector}`);
            await this.page.click(selector);
            await this.page.type(selector, credentials.email, { delay: 100 });
            await this.logInfo(`Email entered: ${credentials.email}`);
            break;
          }
        } catch (e) {
          // Try next selector
        }
      }

      if (!emailField) {
        await this.takeScreenshot('booking-no-email-field.png');
        throw new Error('Email field not found');
      }

      // Click Continue button
      await this.logInfo('Clicking Continue with email');
      const continueButtonSelectors = [
        'button[type="submit"]',
        'button'
      ];

      let continueClicked = false;
      for (const selector of continueButtonSelectors) {
        try {
          const continueBtn = await this.page.$(selector);
          if (continueBtn) {
            await this.page.click(selector);
            await this.logInfo(`Continue button clicked: ${selector}`);
            continueClicked = true;
            break;
          }
        } catch (e) {
          // Try next selector
        }
      }

      if (!continueClicked) {
        await this.page.keyboard.press('Enter');
        await this.logInfo('Pressed Enter as fallback');
      }

      await this.takeScreenshot('booking-after-email.png');
      await this.delay(5000);

      // Check for captcha after email submission
      const pageContent = await this.page.content();
      if (pageContent.includes("Let's make sure you're human") || 
          pageContent.includes("Choose all the clocks")) {
        await this.logInfo('Captcha detected after email submission');
        const captchaHandled = await this.handleCaptcha({ type: 'browserless_ui', sessionUrl: this.sessionUrl });
        if (!captchaHandled) {
          throw new Error('Captcha not solved');
        }
      }

      // Wait for and enter password
      await this.logInfo('Looking for password field');
      const passwordSelectors = [
        'input[type="password"]',
        'input[name="password"]',
        '#password'
      ];

      let passwordField = null;
      let attempts = 0;
      const maxAttempts = 6;

      while (!passwordField && attempts < maxAttempts) {
        for (const selector of passwordSelectors) {
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

      // Enter password
      await this.logInfo('Entering password');
      for (const selector of passwordSelectors) {
        try {
          const field = await this.page.$(selector);
          if (field) {
            const isVisible = await field.isIntersectingViewport();
            if (isVisible) {
              await this.page.click(selector);
              await this.page.type(selector, credentials.password, { delay: 100 });
              await this.logInfo('Password entered');
              break;
            }
          }
        } catch (e) {
          // Try next selector
        }
      }

      // Submit login
      await this.logInfo('Submitting login');
      await this.page.keyboard.press('Enter');
      await this.takeScreenshot('booking-after-password.png');

      // Wait for navigation
      await this.logInfo('Waiting for login response');
      await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

      // Save cookies on successful login
      const finalUrl = this.page.url();
      if ((finalUrl.includes('admin.booking.com') || finalUrl.includes('account.business.booking.com') || finalUrl.includes('partner')) && !finalUrl.includes('sign-in')) {
        await this.logInfo('Login successful');
        const cookies = await this.page.cookies();
        fs.writeFileSync(this.cookiesFile, JSON.stringify(cookies, null, 2));
        await this.logInfo(`Saved ${cookies.length} cookies for future sessions`);
        await this.takeScreenshot('booking-admin-dashboard.png');
      } else {
        await this.logError('Login may have failed', { currentUrl: finalUrl });
        await this.takeScreenshot('booking-login-error.png');
      }

    } catch (error) {
      await this.logError('Login failed', error);
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
      await this.logError('Captcha handling failed', error);
      return false;
    }
  }

  async handle2FA(options?: TwoFactorAuthOptions): Promise<boolean> {
    if (!this.page) return false;

    try {
      const currentUrl = this.page.url();
      if (!currentUrl.includes('2fa') && !currentUrl.includes('verify') && !currentUrl.includes('authentication')) {
        await this.logInfo('No 2FA required');
        return true;
      }

      await this.logInfo('2FA required');
      if (this.sessionUrl) {
        await this.logInfo(`2FA can be completed in Browserless UI: ${this.sessionUrl}`);
      }

      await this.takeScreenshot('booking-2fa-page.png');

      const tfaSelectors = [
        'input[type="text"][maxlength="6"]',
        'input[name="pin"]',
        'input[name="code"]',
        'input[placeholder*="code"]',
        'input[autocomplete="one-time-code"]'
      ];

      for (const selector of tfaSelectors) {
        try {
          await this.page.waitForSelector(selector, { timeout: 10000 });
          await this.logInfo(`Found 2FA field: ${selector}`);
          
          const code = await this.prompt2FA(options?.timeout || 120000);
          await this.page.type(selector, code, { delay: 100 });
          await this.page.keyboard.press('Enter');
          await this.logInfo('2FA code submitted');
          
          await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {
            this.logInfo('Navigation timeout after 2FA');
          });
          
          return true;
        } catch (e) {
          // Try next selector
        }
      }

      await this.logError('2FA field not found');
      return false;
    } catch (error) {
      await this.logError('2FA handling failed', error);
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
      await this.logError('Property search failed', error);
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
      await this.logError('Data scraping failed', error);
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

  // Private helper methods
  private async createBrowserlessSession(): Promise<any> {
    try {
      await this.logInfo('Creating Browserless session with UI access');
      
      const response = await fetch(`https://production-sfo.browserless.io/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.browserlessToken}`
        },
        body: JSON.stringify({
          url: this.baseUrl,
          headless: false,
          stealth: true,
          launch: {
            devtools: true,
            args: ['--start-maximized']
          }
        })
      });
      
      if (response.ok) {
        const session = await response.json() as any;
        await this.logInfo('Browserless session created', { sessionId: session.id });
        return session;
      } else {
        await this.logError(`Session creation failed: ${response.status} ${response.statusText}`);
        return null;
      }
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
}