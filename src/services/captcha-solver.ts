import { Solver } from "2captcha-ts";
import { Page } from "puppeteer";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";

export interface CaptchaSolveResult {
  success: boolean;
  solution?: string;
  error?: string;
  cost?: number;
}

export class TwoCaptchaSolver {
  private solver: Solver;
  private apiKey: string;
  private timeout: number;
  private pollingInterval: number;

  constructor(apiKey: string, timeout = 300000, pollingInterval = 5000) {
    this.apiKey = apiKey;
    this.timeout = timeout;
    this.pollingInterval = pollingInterval;
    this.solver = new Solver(apiKey);
  }

  /**
   * Solve reCAPTCHA v2 challenge
   */
  async solveRecaptchaV2(
    sitekey: string,
    pageUrl: string,
    invisible = false
  ): Promise<CaptchaSolveResult> {
    try {
      await dualLogInfo(
        `Starting reCAPTCHA v2 solving for sitekey: ${sitekey}`
      );

      const result = await this.solver.recaptcha({
        googlekey: sitekey,
        pageurl: pageUrl,
        invisible: invisible,
      });

      await dualLogInfo(
        `reCAPTCHA v2 solved successfully. Solution: ${result.data.substring(
          0,
          50
        )}...`
      );

      return {
        success: true,
        solution: result.data,
        cost: 0.002, // Approximate cost in USD
      };
    } catch (error) {
      await dualLogError("Failed to solve reCAPTCHA v2:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Solve hCaptcha challenge
   */
  async solveHCaptcha(
    sitekey: string,
    pageUrl: string
  ): Promise<CaptchaSolveResult> {
    try {
      await dualLogInfo(`Starting hCaptcha solving for sitekey: ${sitekey}`);

      const result = await this.solver.hcaptcha({
        sitekey: sitekey,
        pageurl: pageUrl,
      });

      await dualLogInfo(
        `hCaptcha solved successfully. Solution: ${result.data.substring(
          0,
          50
        )}...`
      );

      return {
        success: true,
        solution: result.data,
        cost: 0.002,
      };
    } catch (error) {
      await dualLogError("Failed to solve hCaptcha:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Solve AWS WAF captcha challenge
   */
  async solveAWSWAFCaptcha(
    sitekey: string,
    pageUrl: string,
    iv: string,
    context: string
  ): Promise<CaptchaSolveResult> {
    try {
      await dualLogInfo(
        `Starting AWS WAF captcha solving for sitekey: ${sitekey}`
      );

      const result = await this.solver.amazonWaf({
        pageurl: pageUrl,
        sitekey: sitekey,
        iv: iv,
        context: context,
      });

      await dualLogInfo(
        `AWS WAF captcha solved successfully. Solution: ${result.data.substring(
          0,
          50
        )}...`
      );

      return {
        success: true,
        solution: result.data,
        cost: 0.003, // AWS WAF captchas typically cost more
      };
    } catch (error) {
      await dualLogError("Failed to solve AWS WAF captcha:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Solve image-based captcha
   */
  async solveImageCaptcha(
    imageBase64: string,
    instructions?: string
  ): Promise<CaptchaSolveResult> {
    try {
      await dualLogInfo("Starting image captcha solving");

      const result = await this.solver.imageCaptcha({
        body: imageBase64,
        textinstructions: instructions || "Solve the captcha",
      });

      await dualLogInfo(
        `Image captcha solved successfully. Solution: ${result.data}`
      );

      return {
        success: true,
        solution: result.data,
        cost: 0.001,
      };
    } catch (error) {
      await dualLogError("Failed to solve image captcha:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Auto-detect and solve captcha on page
   */
  async autoSolveCaptcha(page: Page): Promise<CaptchaSolveResult> {
    try {
      const pageUrl = page.url();

      // Check for reCAPTCHA v2
      const recaptchaV2 = await page.$("[data-sitekey]");
      if (recaptchaV2) {
        const sitekey = await recaptchaV2.evaluate((el) =>
          el.getAttribute("data-sitekey")
        );
        if (sitekey) {
          await dualLogInfo("Detected reCAPTCHA v2");
          const result = await this.solveRecaptchaV2(sitekey, pageUrl);
          if (result.success && result.solution) {
            await this.injectRecaptchaSolution(page, result.solution);
          }
          return result;
        }
      }

      // Check for hCaptcha
      const hcaptcha = await page.$("[data-sitekey][data-hcaptcha-widget-id]");
      if (hcaptcha) {
        const sitekey = await hcaptcha.evaluate((el) =>
          el.getAttribute("data-sitekey")
        );
        if (sitekey) {
          await dualLogInfo("Detected hCaptcha");
          const result = await this.solveHCaptcha(sitekey, pageUrl);
          if (result.success && result.solution) {
            await this.injectHCaptchaSolution(page, result.solution);
          }
          return result;
        }
      }

      // Check for AWS WAF captcha
      const awsWafCaptcha = await page.$(
        "[data-sitekey][data-iv][data-context]"
      );
      if (awsWafCaptcha) {
        const sitekey = await awsWafCaptcha.evaluate((el) =>
          el.getAttribute("data-sitekey")
        );
        const iv = await awsWafCaptcha.evaluate((el) =>
          el.getAttribute("data-iv")
        );
        const context = await awsWafCaptcha.evaluate((el) =>
          el.getAttribute("data-context")
        );

        if (sitekey && iv && context) {
          await dualLogInfo("Detected AWS WAF captcha");
          const result = await this.solveAWSWAFCaptcha(
            sitekey,
            pageUrl,
            iv,
            context
          );
          if (result.success && result.solution) {
            await this.injectAWSWAFSolution(page, result.solution);
          }
          return result;
        }
      }

      // Check for image captcha
      const captchaImage = await page.$(
        'img[src*="captcha"], img[alt*="captcha"], img[id*="captcha"]'
      );
      if (captchaImage) {
        await dualLogInfo("Detected image captcha");
        const imageBase64 = await this.extractImageAsBase64(page, captchaImage);
        if (imageBase64) {
          const result = await this.solveImageCaptcha(
            imageBase64,
            "Select all clocks or solve the challenge"
          );
          if (result.success && result.solution) {
            await this.inputImageCaptchaSolution(page, result.solution);
          }
          return result;
        }
      }

      return {
        success: false,
        error: "No supported captcha type detected",
      };
    } catch (error) {
      await dualLogError("Auto captcha solving failed:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Inject reCAPTCHA solution into page
   */
  private async injectRecaptchaSolution(
    page: Page,
    solution: string
  ): Promise<void> {
    await page.evaluate((token) => {
      // Set the response in the textarea
      const textarea = document.querySelector(
        "#g-recaptcha-response"
      ) as HTMLTextAreaElement;
      if (textarea) {
        textarea.style.display = "block";
        textarea.value = token;
      }

      // Trigger callback if available
      if (
        (window as any).grecaptcha &&
        (window as any).grecaptcha.getResponse
      ) {
        const widgets = document.querySelectorAll("[data-sitekey]");
        widgets.forEach((widget: any) => {
          if (widget.callback) {
            widget.callback(token);
          }
        });
      }
    }, solution);

    await dualLogInfo("reCAPTCHA solution injected into page");
  }

  /**
   * Inject hCaptcha solution into page
   */
  private async injectHCaptchaSolution(
    page: Page,
    solution: string
  ): Promise<void> {
    await page.evaluate((token) => {
      const textarea = document.querySelector(
        '[name="h-captcha-response"]'
      ) as HTMLTextAreaElement;
      if (textarea) {
        textarea.value = token;
      }
    }, solution);

    await dualLogInfo("hCaptcha solution injected into page");
  }

  /**
   * Inject AWS WAF captcha solution into page
   */
  private async injectAWSWAFSolution(
    page: Page,
    solution: string
  ): Promise<void> {
    await page.evaluate((token) => {
      // AWS WAF typically uses a hidden input field for the captcha response
      const responseField = document.querySelector(
        'input[name="captcha_voucher"], input[name="aws-waf-token"], input[type="hidden"][name*="captcha"]'
      ) as HTMLInputElement;

      if (responseField) {
        responseField.value = token;
      }

      // Also try to find and trigger any AWS WAF callback functions
      if ((window as any).awsWafCaptchaCallback) {
        (window as any).awsWafCaptchaCallback(token);
      }
    }, solution);

    await dualLogInfo("AWS WAF captcha solution injected into page");
  }

  /**
   * Input image captcha solution
   */
  private async inputImageCaptchaSolution(
    page: Page,
    solution: string
  ): Promise<void> {
    const inputSelectors = [
      'input[name*="captcha"]',
      'input[id*="captcha"]',
      'input[placeholder*="captcha"]',
      'input[type="text"]',
    ];

    for (const selector of inputSelectors) {
      const input = await page.$(selector);
      if (input) {
        await input.type(solution);
        await dualLogInfo(`Image captcha solution entered: ${solution}`);
        break;
      }
    }
  }

  /**
   * Extract image as base64 for solving
   */
  private async extractImageAsBase64(
    page: Page,
    imageElement: any
  ): Promise<string | null> {
    try {
      const imageBase64 = await page.evaluate((img) => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;

        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        ctx.drawImage(img, 0, 0);

        return canvas.toDataURL("image/png").split(",")[1];
      }, imageElement);

      return imageBase64;
    } catch (error) {
      await dualLogError("Failed to extract image as base64:", error);
      return null;
    }
  }

  /**
   * Get account balance
   */
  async getBalance(): Promise<number> {
    try {
      const balance = await this.solver.balance();
      await dualLogInfo(`2captcha account balance: $${balance}`);
      return balance;
    } catch (error) {
      await dualLogError("Failed to get 2captcha balance:", error);
      return 0;
    }
  }
}
