import { Browser, Page } from "puppeteer";

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface CaptchaHandlerOptions {
  type: 'manual' | 'automatic' | 'browserless_ui';
  timeout?: number;
  sessionUrl?: string;
  page?: Page;
}

export interface TwoFactorAuthOptions {
  timeout?: number;
  prompt?: (message: string) => Promise<string>;
  page?: Page;
}

export interface ScrapingJobParams {
  jobId?: string;
  propertyId?: string;
  startDate?: string;
  endDate?: string;
  credentials?: LoginCredentials;
  maxPages?: number;
  timeoutMinutes?: number;
}

export interface ScrapingResult {
  success: boolean;
  data?: any;
  error?: string;
  screenshots?: string[];
}

export abstract class BaseScraper {
  protected browser: Browser | null = null;
  protected page: Page | null = null;
  protected platform: string;
  protected baseUrl: string;
  protected jobId?: string;

  constructor(platform: string, baseUrl: string) {
    this.platform = platform;
    this.baseUrl = baseUrl;
  }

  // Abstract methods that each platform must implement
  abstract setupBrowser(jobId?: string): Promise<{ browser: Browser; page: Page }>;
  abstract login(credentials: LoginCredentials, propertyId?: string): Promise<void>;
  abstract handleCaptcha(options?: CaptchaHandlerOptions): Promise<boolean>;
  abstract handle2FA(options?: TwoFactorAuthOptions): Promise<boolean>;
  abstract searchProperty(propertyId: string): Promise<boolean>;
  abstract scrapeData(params: ScrapingJobParams): Promise<ScrapingResult>;
  abstract cleanup(): Promise<void>;

  // Common methods that can be shared across platforms
  protected async takeScreenshot(filename: string): Promise<void> {
    if (this.page) {
      await this.page.screenshot({ path: filename as `${string}.png` });
      console.log(`📸 Screenshot saved: ${filename}`);
    }
  }

  protected async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  protected async logInfo(message: string, data?: any): Promise<void> {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${this.platform}] ${message}`, data || '');
  }

  protected async logError(message: string, error?: any): Promise<void> {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [${this.platform}] ERROR: ${message}`, error || '');
  }

  // Template method that defines the scraping workflow
  async executeScraping(params: ScrapingJobParams): Promise<ScrapingResult> {
    try {
      this.jobId = params.jobId;
      await this.logInfo('Starting scraping process', { platform: this.platform, jobId: params.jobId });

      // Step 1: Setup browser
      const { browser, page } = await this.setupBrowser(params.jobId);
      this.browser = browser;
      this.page = page;

      // Step 2: Login if credentials provided
      if (params.credentials) {
        await this.logInfo('Performing login');
        await this.login(params.credentials, params.propertyId);
        
        // Handle captcha if needed
        const captchaHandled = await this.handleCaptcha();
        if (!captchaHandled) {
          await this.logError('Captcha handling failed');
        }

        // Handle 2FA if needed
        const twoFAHandled = await this.handle2FA();
        if (!twoFAHandled) {
          await this.logInfo('2FA not required or skipped');
        }
      }

      // // Check for multi-property account after successful login
      // const isMultiProperty = await this.checkMultiPropertyAccount();
        
      // // If multi-property account and propertyId is provided, search for the property
      // if (isMultiProperty && propertyId) {
      //   await this.searchAndSelectProperty(propertyId);
      // }

      // // Step 3: Search for property if provided
      // if (params.propertyId) {
      //   await this.logInfo('Searching for property', { propertyId: params.propertyId });
      //   await this.searchProperty(params.propertyId);
      // }

      // Step 4: Scrape data
      await this.logInfo('Starting data scraping');
      const result = await this.scrapeData(params);

      await this.logInfo('Scraping completed successfully');
      return result;

    } catch (error) {
      await this.logError('Scraping failed', error);
      await this.takeScreenshot(`${this.platform}-error-${Date.now()}.png`);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        screenshots: [`${this.platform}-error-${Date.now()}.png`]
      };
    } finally {
      // Cleanup
      await this.cleanup();
    }
  }
}