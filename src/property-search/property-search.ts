import { Browser, Page } from "puppeteer";
import { delay } from "../common/delay.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { progressManager } from "../common/progress-manager.js";
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
      try {
        await page.waitForSelector(".fds-data-table-wrapper", {
          visible: true,
          timeout: selectorTimeout,
        });
      } catch (error: any) {
        await dualLogError("Error waiting for property table:", error);
        
        // Send email notification for property table error
        if (jobId) {
          try {          } catch (emailError) {
            await dualLogError("Failed to send property table error notification:", emailError);
          }
        }
        throw error;
      }

      // Check pause state before proceeding
      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        await dualLogError("Scraping was stopped during property search");
        throw new Error("Scraping was stopped during property search");
      }

      // Wait for property search input
      try {
        await page.waitForSelector(
          ".all-properties__search input.fds-field-input"
        );
      } catch (error: any) {
        await dualLogError("Error waiting for property search input:", error);
        
        // Send email notification for search input error
        if (jobId) {
          try {          } catch (emailError) {
            await dualLogError("Failed to send search input error notification:", emailError);
          }
        }
        throw error;
      }

      // Get property ID from query params
      await dualLogInfo(`Searching for property ID: ${propertyId}`);

      await delay(20000);
      // Type property ID in search
      try {
        await page.type(
          ".all-properties__search input.fds-field-input",
          String(propertyId),
          { delay: 500 }
        );
      } catch (error: any) {
        await dualLogError("Error typing property ID:", error);
        
        // Send email notification for property ID typing error
        if (jobId) {
          try {          } catch (emailError) {
            await dualLogError("Failed to send property ID typing error notification:", emailError);
          }
        }
        throw error;
      }

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
        } else {
          const error = new Error(`Could not find property with ID: ${propertyId}`);
          
          // Send email notification for property not found
          if (jobId) {
            try {            } catch (emailError) {
              await dualLogError("Failed to send property not found error notification:", emailError);
            }
          }
          
          throw error;
        }
      } catch (error: any) {
        await dualLogError(`Error finding/clicking property: ${error.message}`);
        
        // Send email notification for property click error
        if (jobId) {
          try {          } catch (emailError) {
            await dualLogError("Failed to send property click error notification:", emailError);
          }
        }
        
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
        timeout: loadingTimeout,
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
        const error = new Error("Could not find or click Reservations link");
        
        // Send email notification for reservations link error
        if (jobId) {
          try {          } catch (emailError) {
            await dualLogError("Failed to send reservations link error notification:", emailError);
          }
        }
        
        throw error;
      }

      // Wait for navigation to complete
      await Promise.all([
        page.waitForNavigation({
          waitUntil: "networkidle0",
          timeout: loadingTimeout,
        }),
        delay(8000),
      ]);

      await dualLogInfo("Successfully navigated to Reservations page");
    } catch (error: any) {
      await dualLogError(`Error searching for property ${propertyId}:`, error);
      
      // Send email notification for reservations navigation error
      if (jobId) {
        try {        } catch (emailError) {
          await dualLogError("Failed to send reservations navigation error notification:", emailError);
        }
      }
      
      // Close browser when done with this attempt
      if (browser) {
        await browser.close();
      }
      await dualLogInfo("Browser closed successfully.");
      throw error;
    }
  } catch (error: any) {
    await dualLogError(`Error searching for property ${propertyId}:`, error);
    
    // Send email notification for general property search error
    if (jobId) {
      try {      } catch (emailError) {
        await dualLogError("Failed to send general property search error notification:", emailError);
      }
    }
    
    throw error;
  }
}
