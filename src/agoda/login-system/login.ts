import { Page } from "puppeteer";
import { dualLogError, dualLogInfo } from "../../common/log-helper";

async function agodaLogin(
  page: Page,
  agodaUsername: string,
  agodaPassword: string
): Promise<void> {
  // Wait for the input field to appear
  await page.waitForSelector('input[data-cy="unified-email-input"]');

  // Clear the existing value if necessary
  await page.evaluate(() => {
    const inputElement = document.querySelector(
      'input[data-cy="unified-email-input"]'
    );
    if (inputElement) {
      (inputElement as HTMLInputElement).value = "";
    }
  });

  // Type into the input field
  for (let char of agodaUsername) {
    await page.type('input[data-cy="unified-email-input"]', char, {
      delay: 100,
    });
  }

  //wait for the continue button to appear
  const continueButton = await page.waitForSelector(
    'button[data-cy="unified-email-continue-button"]'
  );
  if (!continueButton) {
    await dualLogError("Continue button not found");
    return;
  }
  //click the continue button
  await page.click('button[data-cy="unified-email-continue-button"]');
  dualLogInfo("Continue button clicked");
  
}

export default agodaLogin;
