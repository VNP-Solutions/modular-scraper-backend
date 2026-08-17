import { Browser, Page } from "puppeteer";
import {
  dualLogError,
  dualLogInfo,
  dualLogWarn,
} from "../common/log-helper.js";
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

    const jobId = this.jobId || `trust_verify-${this.propertyIdForDb}`;

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

    await ScreenshotHelper.takeScreenshot(
      this.page,
      jobId,
      step,
      type,
      this.platform,
      this.getScreenshotMirrorJobIds()
    );
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

}
