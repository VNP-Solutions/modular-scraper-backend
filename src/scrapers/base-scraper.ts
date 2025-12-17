import { Browser, Page } from "puppeteer";
import {
  BookingErrorType,
  BookingScrapingPhase,
  getBookingErrorDescription,
} from "../common/booking-error-types.js";
import {
  dualLogError,
  dualLogInfo,
  dualLogWarn,
} from "../common/log-helper.js";
import { otpStatusManager } from "../common/otp-status-manager.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { screenshotManager } from "../common/screenshot-manager.js";
import { JobStatus } from "../models/job.model.js";
import { jobService } from "../services/job.service.js";

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface CaptchaHandlerOptions {
  type?: "manual" | "automatic" | "browserless_ui";
  timeout?: number;
  sessionUrl?: string;
  page?: Page;
  apiKey?: string;
  sitekey?: string;
  invisible?: boolean;
}

export interface TwoFactorAuthOptions {
  timeout?: number;
  prompt?: (message: string) => Promise<string>;
  page?: Page;
}

export interface ScrapingJobParams {
  jobId?: string;
  propertyId?: string;
  propertyIdForDb?: string;
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
  protected propertyIdForDb?: string;
  protected credentials?: LoginCredentials;

  constructor(platform: string, baseUrl: string) {
    this.platform = platform;
    this.baseUrl = baseUrl;
  }

  // Abstract methods that each platform must implement
  abstract setupBrowser(
    jobId?: string
  ): Promise<{ browser: Browser; page: Page }>;
  abstract login(
    credentials: LoginCredentials,
    propertyId?: string
  ): Promise<void>;
  abstract handleCaptcha(options?: CaptchaHandlerOptions): Promise<boolean>;
  abstract handle2FA(options?: TwoFactorAuthOptions): Promise<boolean>;
  abstract searchProperty(propertyId: string): Promise<boolean>;
  abstract scrapeData(params: ScrapingJobParams): Promise<ScrapingResult>;
  abstract cleanup(): Promise<void>;

  // Common methods that can be shared across platforms
  protected async takeScreenshot(filename?: string): Promise<void> {
    if (this.page) {
      let screenshotFilename: string;
      const jobId = this.jobId || `trust_verify-${this.propertyIdForDb}`;

      // Set job ID in screenshot manager
      screenshotManager.setJobId(jobId);

      if (filename) {
        screenshotFilename = filename;
      } else {
        screenshotFilename = screenshotManager.generateStepScreenshotName(
          "last_step",
          jobId
        );
      }

      try {
        const screenshotPath = await screenshotManager.saveScreenshot(
          this.page,
          screenshotFilename,
          jobId
        );
        console.log(`Screenshot saved: ${screenshotPath}`);
      } catch (error) {
        console.error(`Failed to save screenshot: ${error}`);
      }
    }
  }

  protected async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  protected async logInfo(message: string, data?: any): Promise<void> {
    await dualLogInfo(`[${this.platform}] ${message}`, data);
  }

  protected async logError(message: string, error?: any): Promise<void> {
    await dualLogError(`[${this.platform}] ${message}`, error);
  }

  protected async logWarn(message: string, data?: any): Promise<void> {
    await dualLogWarn(`[${this.platform}] ${message}`, data);
  }

  public setPropertyIdForDb(propertyId: string): void {
    this.propertyIdForDb = propertyId;
  }

  // Template method that defines the scraping workflow
  async executeScraping(params: ScrapingJobParams): Promise<ScrapingResult> {
    try {
      this.jobId = params.jobId;
      this.propertyIdForDb = params.propertyIdForDb;

      // Update job ID in screenshot manager and captcha service if available
      if (this.jobId) {
        screenshotManager.setJobId(this.jobId);

        // Clean up any existing screenshots from previous runs of this job
        try {
          await screenshotManager.cleanupJobScreenshots(
            this.jobId,
            "job start cleanup"
          );
          await dualLogInfo(
            "Cleaned up existing screenshots from previous job runs",
            {
              jobId: this.jobId,
              platform: this.platform,
            }
          );
        } catch (cleanupError) {
          await dualLogError(
            "Failed to cleanup existing screenshots at job start",
            cleanupError
          );
        }

        // Update captcha service job ID if it exists (for booking scraper)
        if ((this as any).captchaService) {
          (this as any).captchaService.setJobId(this.jobId);
        }
      }

      await dualLogInfo("Starting scraping process", {
        platform: this.platform,
        jobId: params.jobId,
        propertyId: params.propertyId,
        action: "execute_scraping",
      });

      // Check if scraping should continue before starting
      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        await dualLogError(
          getBookingErrorDescription(BookingErrorType.SCRAPING_STOPPED),
          {
            errorType: BookingErrorType.SCRAPING_STOPPED,
            error: new Error("Scraping was stopped before starting"),
            phase: BookingScrapingPhase.NAVIGATION,
            jobId: params.jobId,
            propertyId: params.propertyId,
            platform: this.platform,
            action: "execute_scraping",
          }
        );
        throw new Error("Scraping was stopped before starting");
      }

      // Step 1: Setup browser
      const { browser, page } = await this.setupBrowser(params.jobId);
      this.browser = browser;
      this.page = page;

      // Step 2: Login if credentials provided
      if (params.credentials) {
        this.credentials = params.credentials;

        // Check if scraping should continue before login
        await scrapingStateManager.waitWhilePaused();
        if (!scrapingStateManager.isRunning()) {
          await dualLogError(
            getBookingErrorDescription(BookingErrorType.SCRAPING_STOPPED),
            {
              errorType: BookingErrorType.SCRAPING_STOPPED,
              error: new Error("Scraping was stopped before login"),
              phase: BookingScrapingPhase.LOGIN,
              jobId: params.jobId,
              propertyId: params.propertyId,
              platform: this.platform,
              action: "login",
            }
          );
          throw new Error("Scraping was stopped before login");
        }

        try {
          await dualLogInfo("Performing login", {
            platform: this.platform,
            jobId: params.jobId,
            propertyId: params.propertyId,
            action: "login",
          });
          await this.login(params.credentials, params.propertyId);

          // Handle captcha if needed
          const captchaHandled = await this.handleCaptcha();
          if (!captchaHandled) {
            await this.logError("Captcha handling failed");
          }

          // Handle 2FA if needed
          const twoFAHandled = await this.handle2FA();
          if (!twoFAHandled) {
            await this.logInfo("2FA not required or skipped");
          }
        } catch (error) {
          const otpReleased = await otpStatusManager.forceReleaseOtp();
          if (otpReleased) {
            console.log("OTP force released after login");
          } else {
            console.log("Failed to force release OTP after login");
          }
          await dualLogError("Login process failed", {
            error: error,
            platform: this.platform,
            jobId: params.jobId,
            propertyId: params.propertyId,
            action: "login",
          });

          throw error;
        }
      }

      // Step 3: Scrape data
      await dualLogInfo("Starting data scraping", {
        platform: this.platform,
        jobId: params.jobId,
        propertyId: params.propertyId,
        action: "scrape_data",
      });

      // Check if scraping should continue before data scraping
      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        await dualLogError(
          getBookingErrorDescription(BookingErrorType.SCRAPING_STOPPED),
          {
            errorType: BookingErrorType.SCRAPING_STOPPED,
            error: new Error("Scraping was stopped before data scraping"),
            phase: BookingScrapingPhase.NAVIGATION,
            jobId: params.jobId,
            propertyId: params.propertyId,
            platform: this.platform,
            action: "scrape_data",
          }
        );
        throw new Error("Scraping was stopped before data scraping");
      }

      const result = await this.scrapeData(params);

      await dualLogInfo("Scraping completed successfully", {
        platform: this.platform,
        jobId: params.jobId,
        propertyId: params.propertyId,
        action: "execute_scraping",
        success: true,
      });

      // Clean up screenshots on successful completion if captcha service is available
      try {
        if (this.jobId && (this as any).captchaService) {
          await (this as any).captchaService.cleanupJobScreenshots(
            this.jobId,
            "job success"
          );
          await dualLogInfo(
            "Screenshots cleaned up after successful completion",
            {
              jobId: this.jobId,
              platform: this.platform,
            }
          );
        }
      } catch (cleanupError) {
        await dualLogError(
          "Failed to cleanup screenshots after success",
          cleanupError
        );
      }

      return result;
    } catch (error) {
      await dualLogError("Scraping failed", error, {
        platform: this.platform,
        jobId: params.jobId,
        propertyId: params.propertyId,
        action: "execute_scraping",
      });
      await this.takeScreenshot(`${this.platform}-error-${Date.now()}.png`);
      //job status change to failed
      if (this.jobId) {
        try {
          await jobService.updateJobStatus(this.jobId, JobStatus.Failed);
          await dualLogInfo("Job status changed to failed", {
            jobId: this.jobId,
            platform: this.platform,
          });
        } catch (jobError) {
          await dualLogError(
            "Failed to change job status to failed",
            jobError,
            {
              jobId: this.jobId,
              platform: this.platform,
              action: "update_job_status",
            }
          );
        }
      }

      // Clean up screenshots on error if captcha service is available
      try {
        if (this.jobId && (this as any).captchaService) {
          await (this as any).captchaService.cleanupJobScreenshots(
            this.jobId,
            "job error"
          );
          await dualLogInfo("Screenshots cleaned up after error", {
            jobId: this.jobId,
            platform: this.platform,
          });
        }
      } catch (cleanupError) {
        await dualLogError(
          "Failed to cleanup screenshots after error",
          cleanupError
        );
      }

      // Ensure scraping state manager is stopped on any error
      try {
        scrapingStateManager.stopScraping();
        await dualLogInfo("Scraping state manager stopped due to error", {
          platform: this.platform,
          jobId: params.jobId,
          propertyId: params.propertyId,
          action: "stop_scraping_state",
        });
      } catch (stateError) {
        await dualLogError(
          "Failed to stop scraping state manager",
          stateError,
          {
            platform: this.platform,
            jobId: params.jobId,
            propertyId: params.propertyId,
            action: "stop_scraping_state_error",
          }
        );
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        screenshots: [`${this.platform}-error-${Date.now()}.png`],
      };
    } finally {
      // Cleanup
      await this.cleanup();
    }
  }
}
