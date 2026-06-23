import puppeteer, { Browser, Page } from "puppeteer";
import { BaseScraper, LoginCredentials, CaptchaHandlerOptions, TwoFactorAuthOptions, ScrapingJobParams, ScrapingResult } from "./base-scraper.js";
import { browserSetupProduction } from "../browser-setup/browser-prod.js";
import { browserSetupLocal } from "../browser-setup/browser-local.js";
import login from "../login/login.js";
import handleOtpVerification from "../otp-verification/otp-verification.js";
import { propertySearchAndClickReservation } from "../property-search/property-search.js";
import { splitDateRange } from "../date-split/date-split.js";
import { scrapingStateManager } from "../common/scraping-state.js";

export class ExpediaScraper extends BaseScraper {
  constructor() {
    super('expedia', 'https://www.expediapartnercentral.com/Account/Logon?signedOff=true');
  }

  async setupBrowser(
    jobId?: string,
    _loginEmail?: string
  ): Promise<{ browser: Browser; page: Page }> {
    try {
      await this.logInfo('Setting up Expedia browser');
      
      // Use existing browser setup logic - choose based on environment
      const { browser, page } = process.env.NODE_ENV === 'production' 
        ? await browserSetupProduction(jobId)
        : await browserSetupLocal(jobId);
      
      await this.logInfo('Expedia browser setup completed');
      return { browser, page };
    } catch (error) {
      await this.logError('Expedia browser setup failed', error);
      throw error;
    }
  }

  async login(credentials: LoginCredentials): Promise<void> {
    if (!this.page || !this.browser) throw new Error('Browser not initialized');

    try {
      await this.logInfo('Starting Expedia login process');
      
      // Check if scraping should continue
      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        throw new Error('Scraping was stopped during login');
      }

      // Use existing login logic - pass browser and page separately
      await login(this.browser, this.page, credentials.email, credentials.password, this.jobId);
      
      await this.logInfo('Expedia login completed successfully');
    } catch (error) {
      await this.logError('Expedia login failed', error);
      throw error;
    }
  }

  async handleCaptcha(options?: CaptchaHandlerOptions): Promise<boolean> {
    // Expedia typically doesn't have captcha in the current implementation
    // But we can add logic here if needed
    await this.logInfo('Captcha handling for Expedia (typically not required)');
    return true;
  }

  async handle2FA(options?: TwoFactorAuthOptions): Promise<boolean> {
    if (!this.page || !this.browser) return false;

    try {
      await this.logInfo('Handling Expedia OTP verification');
      
      // Check if scraping should continue
      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        throw new Error('Scraping was stopped during 2FA');
      }

      // Use existing OTP verification logic - pass browser, page, and jobId
      await handleOtpVerification(this.browser, this.page, this.jobId);
      
      await this.logInfo('Expedia OTP verification completed');
      return true;
    } catch (error) {
      await this.logInfo('OTP verification failed or not required', error);
      // Continue even if OTP fails as it might not be required
      return false;
    }
  }

  async searchProperty(propertyId: string): Promise<boolean> {
    if (!this.page || !this.browser) throw new Error('Browser not initialized');

    try {
      await this.logInfo('Searching for Expedia property', { propertyId });
      
      // Check if scraping should continue
      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        throw new Error('Scraping was stopped during property search');
      }

      // Use existing property search logic - pass browser, page, propertyId, and jobId
      await propertySearchAndClickReservation(this.browser, this.page, propertyId, this.jobId);
      
      await this.logInfo('Expedia property search completed successfully');
      return true;
    } catch (error) {
      await this.logError('Expedia property search failed', error);
      return false;
    }
  }

  async scrapeData(params: ScrapingJobParams): Promise<ScrapingResult> {
    try {
      await this.logInfo('Starting Expedia data scraping');
      
      // Handle date range if provided
      if (params.startDate && params.endDate && params.propertyId) {
        // Check if scraping should continue
        await scrapingStateManager.waitWhilePaused();
        if (!scrapingStateManager.isRunning()) {
          throw new Error('Scraping was stopped during date selection');
        }

        await this.logInfo('Processing date range', { 
          startDate: params.startDate, 
          endDate: params.endDate 
        });

        // Use existing date splitting logic
        await splitDateRange(this.browser!, this.page!, params.startDate, params.endDate, params.propertyId, this.jobId);
        
        await this.logInfo('Date selection completed successfully');
      } else {
        await this.logInfo('No date range provided, skipping date selection');
      }

      await this.takeScreenshot('expedia-scraping-complete.png');
      
      const data = {
        platform: 'expedia',
        timestamp: new Date().toISOString(),
        jobId: params.jobId,
        propertyId: params.propertyId,
        startDate: params.startDate,
        endDate: params.endDate,
        // Additional scraped data would go here
      };

      return {
        success: true,
        data,
        screenshots: ['expedia-scraping-complete.png']
      };
    } catch (error) {
      await this.logError('Expedia data scraping failed', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Expedia scraping failed',
        screenshots: [`expedia-scraping-error-${Date.now()}.png`]
      };
    }
  }

  async cleanup(): Promise<void> {
    try {
      if (this.browser) {
        await this.browser.close();
        await this.logInfo('Expedia browser closed successfully');
      }
    } catch (error) {
      await this.logError('Expedia cleanup failed', error);
    }
  }
}