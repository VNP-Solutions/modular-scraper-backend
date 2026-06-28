import { Page } from "puppeteer";
import {
  humanType,
  moveMouseBezier,
  randomBetween,
  randomPause,
} from "./human-browser-helper.js";

// Generic selector utility functions
export class SelectorUtils {
  /**
   * Check if page is scrolled to the bottom
   */
  static async isAtBottom(page: Page): Promise<boolean> {
    return await page.evaluate(() => {
      return (
        window.innerHeight + window.scrollY >= document.body.scrollHeight - 10
      ); // 10px tolerance
    });
  }

  /**
   * Scroll down by specified pixels
   */
  static async scrollDown(page: Page, pixels: number = 400): Promise<void> {
    await page.evaluate((scrollAmount) => {
      window.scrollBy(0, scrollAmount);
    }, pixels);
    // Wait for content to load and render
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  /**
   * Try multiple selectors until one works, with scrolling support
   */
  static async trySelectors(
    page: Page,
    selectors: string[], 
    action: (selector: string) => Promise<boolean>, 
    timeout: number = 10000
  ): Promise<boolean> {
    for (const selector of selectors) {
      try {
        let element = await page.$(selector);

        if (element) {
          let isVisible = await element.isIntersectingViewport();

          // If element exists but not visible, try scrolling to find it
          if (!isVisible) {
            console.log(
              `Element not visible, attempting to scroll to find: ${selector}`
            );

            while (!(await this.isAtBottom(page))) {
              await this.scrollDown(page, 400);

              // Re-check element and visibility after scrolling
              element = await page.$(selector);
              if (element) {
                isVisible = await element.isIntersectingViewport();
                if (isVisible) {
                  console.log(`Element found after scrolling: ${selector}`);
                  break;
                }
              }
            }
          }

          // Try the action if element is now visible
          if (isVisible) {
            const result = await action(selector);
            if (result) {
              return true;
            }
          } else {
            console.log(
              `Element not visible even after scrolling to bottom: ${selector}`
            );
          }
        } else {
          console.log("Element not found: ", selector);

          // Element not found, try scrolling to see if it loads dynamically
          const initialScrollY = await page.evaluate(() => window.scrollY);

          while (!(await this.isAtBottom(page))) {
            await this.scrollDown(page, 400);

            // Check if element appears after scrolling
            element = await page.$(selector);
            if (element) {
              const isVisible = await element.isIntersectingViewport();
              if (isVisible) {
                console.log(`Element found after scrolling: ${selector}`);
                const result = await action(selector);
                if (result) {
                  return true;
                }
                break;
              }
            }
          }

          // If we scrolled but didn't find anything, scroll back to original position
          if (element === null) {
            await page.evaluate((scrollY) => {
              window.scrollTo(0, scrollY);
            }, initialScrollY);
          }
        }
      } catch (error) {
        // Continue to next selector
        console.log("Error while trying selector: ", error);
        continue;
      }
    }
    console.log("No selector found even after scrolling");
    return false;
  }

  /**
   * Find and click an element using multiple selectors
   */
  static async findAndClick(page: Page, selectors: string[]): Promise<boolean> {
    return this.trySelectors(page, selectors, async (selector) => {
      try {
        await page.waitForSelector(selector, { visible: true, timeout: 5000 });
        const element = await page.$(selector);
        if (!element) return false;

        const box = await element.boundingBox();
        if (!box) return false;

        const targetX = box.x + box.width / 2 + randomBetween(-4, 4);
        const targetY = box.y + box.height / 2 + randomBetween(-3, 3);
        const viewport = page.viewport();
        const startX = randomBetween(
          40,
          Math.max(41, (viewport?.width ?? 1280) - 40)
        );
        const startY = randomBetween(
          40,
          Math.max(41, (viewport?.height ?? 900) - 40)
        );

        await moveMouseBezier(page, startX, startY, targetX, targetY);
        await randomPause(80, 180);
        await page.mouse.click(targetX, targetY);
        return true;
      } catch (error) {
        return false;
      }
    });
  }

  /**
   * Find and type into an element using multiple selectors
   */
  static async findAndType(
    page: Page,
    selectors: string[],
    text: string
  ): Promise<boolean> {
    return this.trySelectors(page, selectors, async (selector) => {
      try {
        await humanType(page, selector, text);
        return true;
      } catch (error) {
        return false;
      }
    });
  }

  /**
   * Check if any of the selectors exist on the page
   */
  static async checkSelectorsExist(
    page: Page,
    selectors: string[]
  ): Promise<boolean> {
    for (const selector of selectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          const isVisible = await element.isIntersectingViewport();
          if (isVisible) {
            return true;
          }
        }
      } catch (error) {
        continue;
      }
    }
    return false;
  }

  /**
   * Wait for any of the selectors to appear
   */
  static async waitForSelector(
    page: Page,
    selectors: string[],
    timeout: number = 10000
  ): Promise<string | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      for (const selector of selectors) {
        try {
          const element = await page.$(selector);
          if (element) {
            const isVisible = await element.isIntersectingViewport();
            if (isVisible) {
              return selector;
            }
          }
        } catch (error) {
          continue;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }
}
