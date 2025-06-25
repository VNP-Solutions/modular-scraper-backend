import { Browser, Page } from "puppeteer";
import { delay } from "../common/delay.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";

async function login(
  browser: Browser,
  page: Page,
  email: string,
  password: string
) {
  // Check if scraping is paused before starting login
  await scrapingStateManager.waitWhilePaused();
  if (!scrapingStateManager.isRunning()) {
    await dualLogError("Scraping was stopped during login");
    throw new Error("Scraping was stopped during login");
  }

  await page.evaluate(() => {
    window.scrollBy(0, 200);
  });
  // Wait for email input
  await page.waitForSelector("#emailControl");

  // Check pause state before entering email
  await scrapingStateManager.waitWhilePaused();
  if (!scrapingStateManager.isRunning()) {
    await dualLogError("Scraping was stopped during login");
    throw new Error("Scraping was stopped during login");
  }

  // Type email slowly, character by character
  await dualLogInfo("Entering email...");
  for (let char of email) {
    await page.type("#emailControl", char, { delay: 100 });
  }

  // Click continue button
  await page.click("#continueButton");

  // Wait before entering password
  await dualLogInfo("Waiting for password page to load...");

  // Check pause state before password entry
  await scrapingStateManager.waitWhilePaused();
  if (!scrapingStateManager.isRunning()) {
    await dualLogError("Scraping was stopped during login");
    throw new Error("Scraping was stopped during login");
  }

  // Wait for password page to be fully loaded
  try {
    await dualLogInfo("Waiting for password page to fully load...");

    // Try to find the password input field with a try-catch to handle both possible selectors
    let passwordInputFound = false;

    try {
      // First try to find #password-input
      const passwordInput = await page.waitForSelector("#password-input", {
        visible: true,
        timeout: 15000, // Shorter timeout for first attempt
      });

      if (passwordInput) {
        passwordInputFound = true;

        // Add a significant delay to ensure the page is fully loaded and stable
        await delay(3000);

        // Verify the password field is actually ready for input
        const isInputReady = await page.evaluate(() => {
          const input = document.querySelector(
            "#password-input"
          ) as HTMLInputElement;
          return input && !input.disabled && document.activeElement !== input;
        });

        if (!isInputReady) {
          await dualLogInfo("Password input not fully ready, waiting longer...");
          await delay(2000);
        }

        // Click on the password field first to ensure focus
        await page.click("#password-input");
        await delay(1000);

        // Clear the field in case there's any text
        await page.evaluate(() => {
          const input = document.querySelector(
            "#password-input"
          ) as HTMLInputElement;
          if (input) input.value = "";
        });
        await delay(500);

        await dualLogInfo("Password page fully loaded, entering password...");

        // Type password slowly with increased delays
        for (let char of password) {
          await page.type("#password-input", char, { delay: 150 }); // Increased delay
          await delay(100); // Increased delay between characters
        }

        // Wait longer before clicking submit to ensure password is fully entered
        await dualLogInfo("Password entered, waiting before clicking submit...");
        await delay(5000);

        // Verify password was entered correctly
        const enteredPassword = await page.evaluate(() => {
          const input = document.querySelector(
            "#password-input"
          ) as HTMLInputElement;
          return input ? input.value : "";
        });

        if (enteredPassword.length !== password.length) {
          await dualLogError(
            `Password entry issue: expected ${password.length} chars but got ${enteredPassword.length}`
          );

          // Re-enter password if needed
          await page.evaluate(() => {
            const input = document.querySelector(
              "#password-input"
            ) as HTMLInputElement;
            if (input) input.value = "";
          });
          await delay(1000);

          // Try again with even slower typing
          for (let char of password) {
            await page.type("#password-input", char, { delay: 200 });
            await delay(150);
          }
          await delay(2000);
        }

        // Click the login button
        await dualLogInfo("Clicking password continue button...");
        await page.click("#password-continue");
      }
    } catch (error: any) {
      await dualLogError(
        "Could not find #password-input, trying #passwordControl instead:",
        error.message
      );
      passwordInputFound = false;
    }

    // If #password-input wasn't found, try #passwordControl
    if (!passwordInputFound) {
      try {
        // Check if #passwordControl exists
        const passwordControlExists = await page.evaluate(() => {
          return !!document.querySelector("#passwordControl");
        });

        if (!passwordControlExists) {
          await dualLogError(
            "Neither #password-input nor #passwordControl found. Checking page content..."
          );
          const pageContent = await page.content();
          await dualLogInfo("Page title: " + (await page.title()));
          throw new Error("Password input field not found on the page");
        }

        // Add a significant delay to ensure the page is fully loaded and stable
        await delay(3000);

        // Verify the password field is actually ready for input
        const isInputReady = await page.evaluate(() => {
          const input = document.querySelector(
            "#passwordControl"
          ) as HTMLInputElement;
          return input && !input.disabled && document.activeElement !== input;
        });

        if (!isInputReady) {
          await dualLogInfo("Password input not fully ready, waiting longer...");
          await delay(2000);
        }

        // Click on the password field first to ensure focus
        await page.click("#passwordControl");
        await delay(1000);

        // Clear the field in case there's any text
        await page.evaluate(() => {
          const input = document.querySelector(
            "#passwordControl"
          ) as HTMLInputElement;
          if (input) input.value = "";
        });
        await delay(500);

        await dualLogInfo("Password page fully loaded, entering password...");

        // Type password slowly with increased delays
        for (let char of password) {
          await page.type("#passwordControl", char, { delay: 150 }); // Increased delay
          await delay(100); // Increased delay between characters
        }

        // Wait longer before clicking submit to ensure password is fully entered
        await dualLogInfo("Password entered, waiting before clicking submit...");
        await delay(5000);

        // Verify password was entered correctly
        const enteredPassword = await page.evaluate(() => {
          const input = document.querySelector(
            "#passwordControl"
          ) as HTMLInputElement;
          return input ? input.value : "";
        });

        if (enteredPassword.length !== password.length) {
          await dualLogError(
            `Password entry issue: expected ${password.length} chars but got ${enteredPassword.length}`
          );

          // Re-enter password if needed
          await page.evaluate(() => {
            const input = document.querySelector(
              "#passwordControl"
            ) as HTMLInputElement;
            if (input) input.value = "";
          });
          await delay(1000);

          // Try again with even slower typing
          for (let char of password) {
            await page.type("#passwordControl", char, { delay: 200 });
            await delay(150);
          }
          await delay(2000);
        }

        // Click the login button
        await dualLogInfo("Clicking password continue button...");
        await page.click("#signInButton");
      } catch (error: any) {
        await dualLogError("Error handling password input:", error.message);
        throw error;
      }
    }
  } catch (error: any) {
    await dualLogError("Error during password entry:", error.message);
    throw error;
  }
}

export default login;
