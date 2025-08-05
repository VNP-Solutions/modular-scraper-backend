import { Browser, Page } from "puppeteer";
import { dualLogInfo } from "../common/log-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { timeoutManager } from "../common/timeout-manager.js";

export function validatePhoneLastThreeDigits(phoneNumber: string, targetPhone: string): boolean {
  const currentLastThree = phoneNumber ? phoneNumber.slice(-3) : "";
  const targetLastThree = targetPhone.slice(-3);
  return currentLastThree === targetLastThree;
}

export async function initializeStateManager(): Promise<void> {
  try {
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogInfo("Scraping state manager indicates stopped - continuing for test mode");
    }
  } catch (error) {
    await dualLogInfo("Scraping state manager not available - running in test mode");
  }
}

export async function getTimeoutConfig(jobId?: string): Promise<{ selectorTimeout: number; loadingTimeout: number }> {
  const selectorTimeout = jobId ? await timeoutManager.getSelectorTimeout(jobId) : 30000;
  const loadingTimeout = jobId ? await timeoutManager.getLoadingTimeout(jobId) : 120000;
  
  return { selectorTimeout, loadingTimeout };
}

export async function submitOtpForm(page: Page, submitSelectors: string[] = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:contains("Continue")',
  'button:contains("Verify")',
  'button:contains("Submit")'
]): Promise<boolean> {
  let submitClicked = false;
  
  for (const selector of submitSelectors) {
    try {
      if (selector.includes('contains')) {
        const clicked = await page.evaluate((buttonText) => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const button = buttons.find(btn => btn.textContent?.includes(buttonText.replace('button:contains("', '').replace('")', '')));
          if (button && !(button as HTMLButtonElement).disabled) {
            (button as HTMLElement).click();
            return true;
          }
          return false;
        }, selector);
        
        if (clicked) {
          await dualLogInfo(`Clicked submit button: ${selector}`);
          submitClicked = true;
          break;
        }
      } else {
        const submitButton = await page.$(selector);
        if (submitButton) {
          const isDisabled = await page.evaluate(
            (button) => (button as HTMLButtonElement).disabled,
            submitButton
          );
          
          if (!isDisabled) {
            await submitButton.click();
            await dualLogInfo(`Clicked submit button: ${selector}`);
            submitClicked = true;
            break;
          }
        }
      }
    } catch (e) {
      continue;
    }
  }

  if (!submitClicked) {
    await page.keyboard.press('Enter');
    await dualLogInfo("Pressed Enter as fallback submit method");
  }

  return submitClicked;
}

export async function waitForNavigation(page: Page, loadingTimeout: number): Promise<void> {
  await page.waitForNavigation({
    waitUntil: "networkidle0",
    timeout: loadingTimeout,
  }).catch(() => {
    dualLogInfo("Navigation timeout after form submission");
  });
}

export async function closeBrowserOnError(browser: Browser): Promise<void> {
  if (browser) {
    await browser.close();
  }
  await dualLogInfo("Browser closed successfully.");
}