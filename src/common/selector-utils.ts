import { Page } from 'puppeteer';

// Generic selector utility functions
export class SelectorUtils {
  /**
   * Try multiple selectors until one works
   */
  static async trySelectors(
    page: Page,
    selectors: string[], 
    action: (selector: string) => Promise<boolean>, 
    timeout: number = 10000
  ): Promise<boolean> {
    for (const selector of selectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          const isVisible = await element.isIntersectingViewport();
          if (isVisible) {
            const result = await action(selector);
            if (result) {
              return true;
            }
          }
        }
      } catch (error) {
        // Continue to next selector
        continue;
      }
    }
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
  
        // Simulate human interaction
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await new Promise(resolve => setTimeout(resolve, 100));
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return true;
      } catch (error) {
        return false;
      }
    });
  }

  /**
   * Find and type into an element using multiple selectors
   */
  static async findAndType(page: Page, selectors: string[], text: string): Promise<boolean> {
    return this.trySelectors(page, selectors, async (selector) => {
      try {
        await page.type(selector, text);
        return true;
      } catch (error) {
        return false;
      }
    });
  }

  /**
   * Check if any of the selectors exist on the page
   */
  static async checkSelectorsExist(page: Page, selectors: string[]): Promise<boolean> {
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
  static async waitForSelector(page: Page, selectors: string[], timeout: number = 10000): Promise<string | null> {
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
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
  }
} 