import { Page } from "puppeteer";
import { dualLogError, dualLogInfo } from "../../common/log-helper.js";
import { takeSuccessScreenshot } from "../../common/screenshot-helper.js";

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Clicks the final submit button. Returns true if the button was clicked, false otherwise.
 */
export async function submitFinalCsv(
  page: Page,
  jobId: string | undefined
): Promise<boolean> {
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
        await delay(2000);
        if (jobId) {
          await takeSuccessScreenshot(
            page,
            jobId,
            "final_form_submit_after_2s_wait"
          );
        }
        await delay(10_000);
        if (jobId) {
          await takeSuccessScreenshot(
            page,
            jobId,
            "final_form_submit_after_12s_from_click"
          );
        }
        return true;
      } catch (error) {
        continue;
      }
    }
    await dualLogError("Final submit button not found with any selector", {
      jobId,
    });
    return false;
  } catch (error: any) {
    await dualLogError("Error clicking final submit button:", error.message, {
      jobId,
    });
    return false;
  }
}
