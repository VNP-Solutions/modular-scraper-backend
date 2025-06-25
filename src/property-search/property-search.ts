import { Page } from "puppeteer";
import { delay } from "../common/delay.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";

export async function propertySearchAndClickReservation(
  page: Page,
  propertyId: string
): Promise<void> {
  try {
    // Check if scraping is paused before starting
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogError("Scraping was stopped during property search");
      throw new Error("Scraping was stopped during property search");
    }

    if (propertyId) {
      // Wait for property table to load
      await page.waitForSelector(".fds-data-table-wrapper", {
        visible: true,
        timeout: 30000,
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
          timeout: 10000,
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
          await dualLogInfo(`Found and clicked property with ID: ${propertyId}`);

          // Wait for navigation
          await Promise.all([
            page.waitForNavigation({
              waitUntil: "networkidle0",
              timeout: 30000,
            }),
            delay(8000),
          ]);

          await dualLogInfo("Successfully navigated to property page");
        } else {
          throw new Error(`Could not find property with ID: ${propertyId}`);
        }
      } catch (error: any) {
        await dualLogError(`Error finding/clicking property: ${error.message}`);
        throw error;
      }
    }

    // Check pause state before finding reservations
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogError("Scraping was stopped during property search");
      throw new Error("Scraping was stopped during property search");
    }

    // Find and click the Reservations link
    await dualLogInfo("Looking for Reservations link...");

    try {
      // Wait for the drawer content to load
      await page.waitForSelector(".uitk-drawer-content", {
        visible: true,
        timeout: 30000,
      });

      // Click using JavaScript with the exact structure
      const clicked = await page.evaluate(() => {
        const reservationsItem = Array.from(
          document.querySelectorAll(".uitk-action-list-item-content")
        ).find((item) => {
          const textDiv = item.querySelector(".uitk-text.overflow-wrap");
          return textDiv && textDiv.textContent?.trim() === "Reservations";
        });

        if (reservationsItem) {
          const link = reservationsItem.querySelector(
            "a.uitk-action-list-item-link"
          );
          if (link instanceof HTMLElement) {
            link.click();
            return true;
          }
        }
        return false;
      });

      if (!clicked) {
        throw new Error("Could not find or click Reservations link");
      }

      // Wait for navigation to complete
      await Promise.all([
        page.waitForNavigation({
          waitUntil: "networkidle0",
          timeout: 80000,
        }),
        delay(8000),
      ]);

      await dualLogInfo("Successfully navigated to Reservations page");
    } catch (error) {
      await dualLogError(`Error searching for property ${propertyId}:`, error);
      throw error;
    }
  } catch (error: any) {
    await dualLogError(`Error searching for property ${propertyId}:`, error);
    throw error;
  }
}
