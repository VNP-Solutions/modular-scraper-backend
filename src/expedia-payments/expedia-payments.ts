import { Browser, Page } from "puppeteer";
import { delay } from "../common/delay.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { timeoutManager } from "../common/timeout-manager.js";

/**
 * Click on "Request payment from Expedia Group" in Quick tasks section
 * and set date range
 */
export async function clickExpediaPaymentandsetDaterange(
  browser: Browser,
  page: Page,
  startDate: string,
  endDate: string,
  jobId?: string
): Promise<void> {
  try {
    // Check if scraping is paused before starting
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogError("Scraping was stopped during payment click");
      throw new Error("Scraping was stopped during payment click");
    }

    // Get timeout configuration for this job
    const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);

    await dualLogInfo(
      "Looking for 'Request payment from Expedia Group' link..."
    );

    try {
      // Wait for the Quick tasks section to load
      await page.waitForSelector(".finance-quick-tasks-card", {
        visible: true,
        timeout: loadingTimeout,
      });

      await dualLogInfo("Quick tasks section found");

      // Click on "Request payment from Expedia Group" link
      const clicked = await page.evaluate(() => {
        const menuItems = Array.from(
          document.querySelectorAll(".fds-menulist-item")
        );

        for (const item of menuItems) {
          const link = item.querySelector("a.fds-menulist-item-label");
          if (
            link &&
            link.textContent?.trim() === "Request payment from Expedia Group"
          ) {
            if (link instanceof HTMLElement) {
              link.click();
              return true;
            }
          }
        }
        return false;
      });

      if (!clicked) {
        throw new Error(
          "Could not find or click 'Request payment from Expedia Group' link"
        );
      }

      await dualLogInfo(
        "Successfully clicked 'Request payment from Expedia Group'"
      );

      // Wait for navigation to complete
      await Promise.all([
        page.waitForNavigation({
          waitUntil: "networkidle0",
          timeout: loadingTimeout,
        }),
        delay(5000),
      ]);

      //in here
      await dualLogInfo(
        "Successfully navigated to Request payment from Expedia Group page"
      );

      // Check if reservations are already showing
      await delay(3000);

      const hasReservations = await page.evaluate(() => {
        const searchSummary = document.querySelector("#searchSummary");
        return searchSummary !== null;
      });

      if (hasReservations) {
        await dualLogInfo(
          "Reservations found, clicking 'Add more reservation IDs'..."
        );

        // Click on "Add more reservation IDs" link
        const showSearchClicked = await page.evaluate(() => {
          const showSearchLink = document.querySelector("a.showSearch");
          if (showSearchLink && showSearchLink instanceof HTMLElement) {
            showSearchLink.click();
            return true;
          }
          return false;
        });

        if (!showSearchClicked) {
          throw new Error(
            "Could not find or click 'Add more reservation IDs' link"
          );
        }

        await dualLogInfo(
          "Clicked 'Add more reservation IDs', waiting for page update..."
        );
        await delay(3000);
      } else {
        await dualLogInfo(
          "No existing reservations, proceeding to date range tab..."
        );
      }

      // Click on "By Date Range" tab
      await dualLogInfo("Looking for 'By Date Range' tab...");

      const dateRangeTabClicked = await page.evaluate(() => {
        // Try to find the button by ID first
        const dateRangeButton = document.querySelector("#tab-dateRangeSearch");
        if (dateRangeButton && dateRangeButton instanceof HTMLElement) {
          dateRangeButton.click();
          return true;
        }

        // Fallback: find by text content
        const buttons = Array.from(document.querySelectorAll("button"));
        for (const button of buttons) {
          const label = button.querySelector(".tab-label");
          if (label && label.textContent?.trim() === "By Date Range") {
            button.click();
            return true;
          }
        }
        return false;
      });

      if (!dateRangeTabClicked) {
        throw new Error("Could not find or click 'By Date Range' tab");
      }

      await dualLogInfo("Successfully clicked 'By Date Range' tab");
      await delay(2000);

      await dualLogInfo("Date range tab is ready for input");
    } catch (error) {
      await dualLogError("Error clicking payment link:", error);
      // Close browser when done with this attempt
      if (browser) {
        await browser.close();
      }
      await dualLogInfo("Browser closed successfully.");
      throw error;
    }
  } catch (error: any) {
    await dualLogError("Error in clickExpediaPaymentandsetDaterange:", error);
    throw error;
  }
}
