import { Page } from "puppeteer";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function submitFinalCsv(page: Page, jobId: string | undefined) {
  await dualLogInfo("Clicking final submit button...", { jobId });
  try {
    const finalSubmitSelectors = [
      'button[data-testid="submit-button"]',
      'button[type="submit"]',
      'button:has-text("Submit")',
    ];

    for (const selector of finalSubmitSelectors) {
      try {
        await page.waitForSelector(selector, {
          visible: true,
          timeout: 10000,
        });
        await page.click(selector);
        await dualLogInfo(
          `✅ Clicked final submit button with selector: ${selector}`,
          { jobId }
        );
        break;
      } catch (error) {
        continue;
      }
    }
  } catch (error: any) {
    await dualLogError("Error clicking final submit button:", error.message, {
      jobId,
    });
  }

  await delay(2000); // Give time for form submission to process
}
