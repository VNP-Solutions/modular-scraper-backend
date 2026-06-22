import { Browser, Page } from "puppeteer";
import { delay } from "../common/delay.js";
import { FAILED_REASON, setFailedReasonCode } from "../common/failed-reason.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { timeoutManager } from "../common/timeout-manager.js";

export async function propertySearchAndClickReservation(
  browser: Browser,
  page: Page,
  propertyId: string,
  jobId?: string
): Promise<void> {
  try {
    // Check if scraping is paused before starting
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogError("Scraping was stopped during property search");
      throw new Error("Scraping was stopped during property search");
    }

    // Get timeout configuration for this job
    const selectorTimeout = await timeoutManager.getSelectorTimeout(jobId);
    const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);

    if (propertyId) {
      // Wait for property table to load
      await page.waitForSelector(".fds-data-table-wrapper", {
        visible: true,
        timeout: selectorTimeout,
      });

      // Check pause state before proceeding
      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        await dualLogError("Scraping was stopped during property search");
        throw new Error("Scraping was stopped during property search");
      }

      // Wait for property search input
      await page.waitForSelector(
        ".all-properties__search input.fds-field-input"
      );

      // Get property ID from query params
      await dualLogInfo(`Searching for property ID: ${propertyId}`);

      await delay(20000);
      // Type property ID in search
      await page.type(
        ".all-properties__search input.fds-field-input",
        String(propertyId),
        { delay: 500 }
      );

      // Wait for search results
      await delay(2000);

      // Check pause state before searching
      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        await dualLogError("Scraping was stopped during property search");
        throw new Error("Scraping was stopped during property search");
      }

      // Find and click the property link with more specific selector
      try {
        // Wait for search results to update
        await page.waitForSelector("tbody tr", {
          visible: true,
          timeout: loadingTimeout,
        });

        // Find and click the property link
        const clicked = await page.evaluate((searchId) => {
          const rows = Array.from(document.querySelectorAll("tbody tr"));
          for (const row of rows) {
            const idElement = row.querySelector(
              ".property-cell__property-id span"
            );
            if (idElement && idElement.textContent?.includes(searchId)) {
              const link = row.querySelector(".property-cell__property-name a");
              if (link && link instanceof HTMLElement) {
                link.click();
                return true;
              }
            }
          }
          return false;
        }, String(propertyId));

        if (clicked) {
          await dualLogInfo(
            `Found and clicked property with ID: ${propertyId}`
          );

          // Wait for navigation
          await Promise.all([
            page.waitForNavigation({
              waitUntil: "networkidle0",
              timeout: loadingTimeout,
            }),
            delay(8000),
          ]);

          await dualLogInfo("Successfully navigated to property page");
          await dualLogInfo(`Property ${propertyId} located.`);
        } else {
          const notFoundError = new Error(
            `Could not find property with ID: ${propertyId}`
          );
          setFailedReasonCode(notFoundError, FAILED_REASON.PROPERTY_NOT_FOUND);
          throw notFoundError;
        }
      } catch (error: any) {
        await dualLogError(`Error finding/clicking property: ${error.message}`);
        throw error;
      }
    }
  } catch (error: any) {
    await dualLogError(`Error searching for property ${propertyId}:`, error);
    throw error;
  }
}
