import { Page } from "puppeteer";
import { dualLogInfo, dualLogWarn } from "./log-helper.js";

/**
 * Dynamic waiting utility that waits indefinitely for elements to appear
 * with intelligent retry logic and progress reporting
 */
export class DynamicWaiter {
  private static readonly DEFAULT_CHECK_INTERVAL = 2000; // 2 seconds
  private static readonly LOG_INTERVAL = 30000; // Log progress every 30 seconds

  /**
   * Debug helper to see what elements are actually present on the page
   */
  static async debugPageElements(
    page: Page,
    searchTerm: string = "input"
  ): Promise<void> {
    try {
      const elements = await page.evaluate((term) => {
        const allElements = document.querySelectorAll(term);
        return Array.from(allElements).map((el) => ({
          tagName: el.tagName,
          id: el.id,
          className: el.className,
          dataCy: el.getAttribute("data-cy"),
          type: el.getAttribute("type"),
          placeholder: el.getAttribute("placeholder"),
          name: el.getAttribute("name"),
          outerHTML: el.outerHTML.substring(0, 200) + "...",
        }));
      }, searchTerm);

      await dualLogInfo(
        `🔍 Found ${elements.length} elements matching "${searchTerm}":`,
        elements
      );
    } catch (error) {
      await dualLogWarn("Error debugging page elements:", error);
    }
  }

  /**
   * Wait for a selector to appear with no time limit
   * Uses intelligent polling with progress reporting
   */
  static async waitForSelectorInfinite(
    page: Page,
    selector: string,
    options: {
      checkInterval?: number;
      logInterval?: number;
      description?: string;
      debugOnFailure?: boolean;
    } = {}
  ): Promise<any> {
    const {
      checkInterval = this.DEFAULT_CHECK_INTERVAL,
      logInterval = this.LOG_INTERVAL,
      description = `selector "${selector}"`,
      debugOnFailure = true,
    } = options;

    await dualLogInfo(`🔍 Starting infinite wait for ${description}`);

    const startTime = Date.now();
    let lastLogTime = startTime;
    let attemptCount = 0;
    let hasDebugged = false;

    while (true) {
      attemptCount++;
      const currentTime = Date.now();
      const elapsedTime = currentTime - startTime;

      try {
        // First try with visible: true
        let element = await page.waitForSelector(selector, {
          timeout: checkInterval / 2,
          visible: true,
        });

        if (element) {
          const totalWaitTime = (currentTime - startTime) / 1000;
          await dualLogInfo(
            `Element found after ${totalWaitTime.toFixed(
              1
            )}s (${attemptCount} attempts): ${description}`
          );
          return element;
        }

        // If not found with visible:true, try without visible requirement
        element = await page.waitForSelector(selector, {
          timeout: checkInterval / 2,
          visible: false,
        });

        if (element) {
          await dualLogInfo(
            `Element found but may not be visible: ${description}`
          );
          // Wait a bit for it to become visible
          await new Promise((resolve) => setTimeout(resolve, 1000));
          return element;
        }
      } catch (timeoutError) {
        // If we've been waiting for a while and haven't debugged yet, do it now
        if (debugOnFailure && !hasDebugged && elapsedTime > 10000) {
          await dualLogInfo(
            `🔍 Debugging page elements after ${Math.floor(
              elapsedTime / 1000
            )}s of waiting...`
          );
          await this.debugPageElements(page, "input");
          await this.debugPageElements(page, "[data-cy]");
          hasDebugged = true;
        }

        // Log progress periodically
        if (currentTime - lastLogTime >= logInterval) {
          const elapsedMinutes = Math.floor(elapsedTime / 60000);
          const elapsedSeconds = Math.floor((elapsedTime % 60000) / 1000);

          await dualLogInfo(
            `⏳ Still waiting for ${description} - ${elapsedMinutes}m ${elapsedSeconds}s elapsed (${attemptCount} attempts)`
          );
          lastLogTime = currentTime;

          // Debug again every minute if still not found
          if (debugOnFailure && elapsedTime > 60000) {
            await this.debugPageElements(page, "input");
          }
        }

        // Check if page is still responsive
        try {
          await page.evaluate(() => document.readyState);
        } catch (pageError) {
          await dualLogWarn(
            "Page seems unresponsive, but continuing to wait...",
            pageError
          );
        }

        // Small delay before next attempt
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  /**
   * Wait for multiple selectors (any one of them)
   */
  static async waitForAnySelector(
    page: Page,
    selectors: string[],
    options: {
      checkInterval?: number;
      logInterval?: number;
      description?: string;
    } = {}
  ): Promise<{ element: any; selector: string; index: number }> {
    const {
      checkInterval = this.DEFAULT_CHECK_INTERVAL,
      logInterval = this.LOG_INTERVAL,
      description = `any of: ${selectors.join(", ")}`,
    } = options;

    await dualLogInfo(`🔍 Starting infinite wait for ${description}`);

    const startTime = Date.now();
    let lastLogTime = startTime;
    let attemptCount = 0;

    while (true) {
      attemptCount++;
      const currentTime = Date.now();
      const elapsedTime = currentTime - startTime;

      // Try each selector
      for (let i = 0; i < selectors.length; i++) {
        const selector = selectors[i];
        try {
          const element = await page.waitForSelector(selector, {
            timeout: 100, // Very short timeout for each attempt
            visible: true,
          });

          if (element) {
            const totalWaitTime = (currentTime - startTime) / 1000;
            await dualLogInfo(
              `Element found: "${selector}" after ${totalWaitTime.toFixed(
                1
              )}s (${attemptCount} attempts)`
            );
            return { element, selector, index: i };
          }
        } catch (timeoutError) {
          // Continue to next selector
        }
      }

      // Log progress periodically
      if (currentTime - lastLogTime >= logInterval) {
        const elapsedMinutes = Math.floor(elapsedTime / 60000);
        const elapsedSeconds = Math.floor((elapsedTime % 60000) / 1000);

        await dualLogInfo(
          `⏳ Still waiting for ${description} - ${elapsedMinutes}m ${elapsedSeconds}s elapsed (${attemptCount} attempts)`
        );
        lastLogTime = currentTime;
      }

      // Small delay before next round
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }
  }

  /**
   * Wait for an element to appear and then be clickable
   */
  static async waitForClickableElement(
    page: Page,
    selector: string,
    options: {
      checkInterval?: number;
      logInterval?: number;
      description?: string;
    } = {}
  ): Promise<any> {
    const element = await this.waitForSelectorInfinite(page, selector, options);

    // Wait a bit more to ensure it's fully interactive
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify it's clickable
    try {
      await page.waitForFunction(
        (sel) => {
          const el = document.querySelector(sel);
          return (
            el &&
            !el.hasAttribute("disabled") &&
            getComputedStyle(el).pointerEvents !== "none"
          );
        },
        { timeout: 5000 },
        selector
      );

      await dualLogInfo(
        `Element is clickable: ${options.description || selector}`
      );
      return element;
    } catch (clickableError) {
      await dualLogWarn(
        `Element found but may not be clickable yet: ${selector}`,
        clickableError
      );
      return element; // Return anyway, let caller decide
    }
  }

  /**
   * Wait for page to be in a specific state (like navigation completion)
   */
  static async waitForPageState(
    page: Page,
    stateCheck: () => Promise<boolean>,
    options: {
      checkInterval?: number;
      logInterval?: number;
      description?: string;
    } = {}
  ): Promise<void> {
    const {
      checkInterval = this.DEFAULT_CHECK_INTERVAL,
      logInterval = this.LOG_INTERVAL,
      description = "page state condition",
    } = options;

    await dualLogInfo(`🔍 Waiting for ${description}`);

    const startTime = Date.now();
    let lastLogTime = startTime;
    let attemptCount = 0;

    while (true) {
      attemptCount++;
      const currentTime = Date.now();
      const elapsedTime = currentTime - startTime;

      try {
        if (await stateCheck()) {
          const totalWaitTime = (currentTime - startTime) / 1000;
          await dualLogInfo(
            `Condition met after ${totalWaitTime.toFixed(
              1
            )}s (${attemptCount} attempts): ${description}`
          );
          return;
        }
      } catch (error) {
        await dualLogWarn(`Error checking condition: ${description}`, error);
      }

      // Log progress periodically
      if (currentTime - lastLogTime >= logInterval) {
        const elapsedMinutes = Math.floor(elapsedTime / 60000);
        const elapsedSeconds = Math.floor((elapsedTime % 60000) / 1000);

        await dualLogInfo(
          `⏳ Still waiting for ${description} - ${elapsedMinutes}m ${elapsedSeconds}s elapsed (${attemptCount} attempts)`
        );
        lastLogTime = currentTime;
      }

      // Small delay before next check
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }
  }

  /**
   * Enhanced page navigation with infinite waiting
   */
  static async navigateAndWaitInfinite(
    page: Page,
    url: string,
    waitForSelector?: string,
    options: {
      description?: string;
    } = {}
  ): Promise<void> {
    const { description = `navigation to ${url}` } = options;

    await dualLogInfo(`🚀 Starting ${description}`);

    try {
      // Navigate without timeout restrictions
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 0, // No timeout
      });

      await dualLogInfo(`Page loaded: ${url}`);

      // If a selector is specified, wait for it
      if (waitForSelector) {
        await this.waitForSelectorInfinite(page, waitForSelector, {
          description: `element after navigation: ${waitForSelector}`,
        });
      }
    } catch (error) {
      await dualLogWarn(
        `Navigation error for ${url}, but continuing...`,
        error
      );

      // If navigation fails, still try to wait for the selector
      if (waitForSelector) {
        await this.waitForSelectorInfinite(page, waitForSelector, {
          description: `element after failed navigation: ${waitForSelector}`,
        });
      }
    }
  }
}
