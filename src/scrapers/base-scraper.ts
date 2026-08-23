import { Browser, Page } from "puppeteer";
import {
  dualLogError,
  dualLogInfo,
  dualLogWarn,
} from "../common/log-helper.js";
import { OtaPlatform } from "../common/ota-verification-patch.js";
import { ScreenshotHelper } from "../common/screenshot-helper.js";

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

export abstract class BaseScraper {
  protected browser: Browser | null = null;
  protected page: Page | null = null;
  protected platform: string;
  protected baseUrl: string;
  protected jobId?: string;
  protected propertyIdForDb?: string;
  protected credentials?: LoginCredentials;
  /** Property-check runs have no Job, so screenshots are recorded on these properties instead. */
  protected screenshotPropertyIds?: string[];
  /** Groups one property-check run's screenshots under a single S3 prefix. */
  protected screenshotRunId?: string;

  constructor(platform: string, baseUrl: string) {
    this.platform = platform;
    this.baseUrl = baseUrl;
  }

  // Abstract methods that each platform must implement
  abstract setupBrowser(
    jobId?: string,
    loginEmail?: string
  ): Promise<{ browser: Browser; page: Page }>;
  abstract login(
    credentials: LoginCredentials,
    propertyId?: string
  ): Promise<void>;
  abstract handleCaptcha(options?: CaptchaHandlerOptions): Promise<boolean>;
  abstract handle2FA(options?: TwoFactorAuthOptions): Promise<boolean>;
  abstract searchProperty(propertyId: string): Promise<boolean>;
  abstract cleanup(): Promise<void>;

  /**
   * Optional: duplicate screenshot DB entries to these job IDs (booking group shared login).
   */
  protected getScreenshotMirrorJobIds(): string[] | undefined {
    return undefined;
  }

  // Common methods that can be shared across platforms
  protected async takeScreenshot(stepName?: string): Promise<void> {
    if (!this.page) return;

    // Derive a clean step label: strip file extension and timestamp noise if a
    // filename was passed (legacy callers), otherwise use "step" + counter.
    let step: string;
    if (stepName) {
      // Strip .png extension and trailing timestamps like -1234567890
      step = stepName
        .replace(/\.png$/i, "")
        .replace(/-\d{10,}$/, "");
    } else {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      step = `booking_step_${ts}`;
    }

    // Determine type: treat names containing "error" as error screenshots
    const type: "step" | "error" = /error/i.test(step) ? "error" : "step";

    if (this.jobId) {
      await ScreenshotHelper.takeScreenshot(
        this.page,
        this.jobId,
        step,
        type,
        this.platform,
        this.getScreenshotMirrorJobIds()
      );
      return;
    }

    if (this.screenshotRunId && this.screenshotPropertyIds?.length) {
      await ScreenshotHelper.takeScreenshotForProperties(
        this.page,
        this.screenshotRunId,
        this.screenshotPropertyIds,
        step,
        type,
        this.platform as OtaPlatform
      );
      return;
    }

    // No Job and no properties to attribute this to — skip rather than upload
    // an image to S3 that nothing will ever reference.
    await this.logWarn(`Screenshot skipped, no destination: ${step}`);
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

  /**
   * Route screenshots to property documents instead of a Job.
   *
   * Used by the Booking.com property check, which runs without a Job: every
   * screenshot the scraper takes during login/captcha/2FA is recorded against
   * all properties in the run, since those steps happen before any single
   * property is identified.
   */
  public setScreenshotProperties(runId: string, propertyIds: string[]): void {
    this.screenshotRunId = runId;
    this.screenshotPropertyIds = propertyIds;
  }

}
