import { Browser, Page } from "puppeteer";
import { delay } from "../common/delay.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { timeoutManager } from "../common/timeout-manager.js";
import { scrapeData } from "../scrape-data/scrape-data.js";
import { setDateRange } from "./helper.js";

export async function applyFilter(
  browser: Browser,
  page: Page,
  startDate: string,
  endDate: string,
  expediaId: string,
  jobId?: string
) {
  try {
    // Check if scraping is paused before starting
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      throw new Error("Scraping was stopped during filter application");
    }

    // Get timeout configuration for this job
    const selectorTimeout = await timeoutManager.getSelectorTimeout(jobId);
    const loadingTimeout = await timeoutManager.getLoadingTimeout(jobId);

    // Click the "Checking out" radio button
    await dualLogInfo('Selecting "Checking out" filter...');
    await page.evaluate(() => {
      const radioButtons = Array.from(
        document.querySelectorAll('input[type="radio"][name="dateTypeFilter"]')
      );
      const checkingOutButton = radioButtons.find((radio) => {
        const parentElement = radio.parentElement;
        if (!parentElement) return false;
        const switchLabel = parentElement.querySelector(".fds-switch-label");
        if (!switchLabel || !switchLabel.textContent) return false;
        return switchLabel.textContent.trim() === "Checking out";
      });
      if (checkingOutButton) {
        (checkingOutButton as HTMLElement).click();
      }
    });

    // Wait for radio button click to take effect
    await delay(2000);

    // Check pause state before setting date range
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      throw new Error("Scraping was stopped during filter application");
    }

    // Set the date range
    await dualLogInfo(`Processing date range: ${startDate} to ${endDate}`);
    const dateValues = await setDateRange(page, startDate, endDate, jobId);
    await dualLogInfo("Set dates:", dateValues);

    // Check pause state before applying more filters
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      throw new Error("Scraping was stopped during filter application");
    }

    //wait for the more filter button
    await dualLogInfo("Waiting for the More filters button...");
    await page.waitForSelector(
      "button.fds-button2.utility.fds-dropdown-trigger",
      {
        visible: true,
        timeout: selectorTimeout,
      }
    );

    // Click the More filters button
    await page.evaluate(() => {
      const moreFiltersButton = Array.from(
        document.querySelectorAll(
          "button.fds-button2.utility.fds-dropdown-trigger"
        )
      ).find((button) => {
        const label = button.querySelector(".fds-button2-label");
        return (
          label &&
          label.textContent &&
          label.textContent.trim() === "More filters"
        );
      });

      if (moreFiltersButton) {
        (moreFiltersButton as HTMLElement).click();
        return true;
      }
      throw new Error("More filters button not found");
    });

    await dualLogInfo(
      "Clicked More filters button, waiting for dropdown to appear..."
    );

    // Check the "Expedia Collect Payments" and "Expedia Virtual Card" checkboxes
    await page.evaluate(() => {
      // Find all checkbox labels
      const checkboxLabels = Array.from(
        document.querySelectorAll(".fds-switch-checkbox")
      );

      // Find and click the "Expedia Collect Payments" checkbox
      const expediaCollectPaymentsLabel = checkboxLabels.find((label) => {
        const switchLabel = label.querySelector(".fds-switch-label");
        return (
          switchLabel &&
          switchLabel.textContent &&
          switchLabel.textContent.trim() === "Expedia Collect Payments"
        );
      });

      if (expediaCollectPaymentsLabel) {
        const checkbox = expediaCollectPaymentsLabel.querySelector(
          "input.fds-switch-input"
        ) as HTMLInputElement;
        if (checkbox && !checkbox.checked) {
          checkbox.click();
          console.log('Checked "Expedia Collect Payments" checkbox');
        }
      } else {
        console.log('Could not find "Expedia Collect Payments" checkbox');
      }

      // Find and click the "Expedia Virtual Card" checkbox
      const expediaVirtualCardLabel = checkboxLabels.find((label) => {
        const switchLabel = label.querySelector(".fds-switch-label");
        return (
          switchLabel &&
          switchLabel.textContent &&
          switchLabel.textContent.trim() === "Expedia Virtual Card"
        );
      });

      if (expediaVirtualCardLabel) {
        const checkbox = expediaVirtualCardLabel.querySelector(
          "input.fds-switch-input"
        ) as HTMLInputElement;
        if (checkbox && !checkbox.checked) {
          checkbox.click();
          console.log('Checked "Expedia Virtual Card" checkbox');
        }
      } else {
        console.log('Could not find "Expedia Virtual Card" checkbox');
      }
    });

    await dualLogInfo(
      "Selected 'Expedia Collect Payments' and 'Expedia Virtual Card' checkboxes"
    );
    await delay(1000); // Wait for checkboxes to be checked

    // Click the Apply button in the dropdown
    await page.evaluate(() => {
      const filterApplyButton = Array.from(
        document.querySelectorAll(
          ".fds-dropdown-actions button.fds-button2.utility"
        )
      ).find((button) => {
        const label = button.querySelector(".fds-button2-label");
        return (
          label && label.textContent && label.textContent.trim() === "Apply"
        );
      });

      if (filterApplyButton) {
        (filterApplyButton as HTMLElement).click();
        return true;
      }
    });

    await dualLogInfo("Applied filters from dropdown");
    await delay(2000);

    await dualLogInfo("Waiting for data to load...");

    // Wait for the loading indicator to appear
    await page
      .waitForSelector("td .fds-loader.is-loading.is-visible", {
        visible: true,
        timeout: selectorTimeout,
      })
      .catch(() => dualLogInfo("Loading indicator did not appear"));

    // Wait for the loading indicator to disappear
    await page.waitForSelector("td .fds-loader.is-loading.is-visible", {
      hidden: true,
      timeout: loadingTimeout,
    });

    await dualLogInfo("Loading completed, continuing with data processing...");

    // Check pause state before data processing
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      throw new Error("Scraping was stopped before data processing");
    }

    await dualLogInfo("Starting to process reservation data...");

    // Wait for the table to be visible
    await page.waitForSelector("table.fds-data-table", {
      visible: true,
      timeout: selectorTimeout,
    });

    // Wait for data to load and stabilize
    let previousCount = 0;
    let attempts = 0;
    const maxAttempts = 15; // Increased max attempts

    while (attempts < maxAttempts) {
      // Check pause state during data stabilization
      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        throw new Error("Scraping was stopped during data stabilization");
      }

      await delay(2000);

      const currentCount = await page.evaluate(() => {
        return document.querySelectorAll("td.guestName button.guestNameLink")
          .length;
      });

      console.log(
        `Found ${currentCount} reservations on attempt ${attempts + 1}...`
      );

      if (currentCount === previousCount && currentCount > 0) {
        console.log("Data count stabilized");
        break;
      }

      previousCount = currentCount;
      attempts++;
    }

    // Final verification
    const finalCount = await page.evaluate(() => {
      return document.querySelectorAll("td.guestName button.guestNameLink")
        .length;
    });

    if (finalCount === 0) {
      console.log("No reservations found after multiple attempts");
      return;
    }

    // Check pause state before setting pagination
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      throw new Error("Scraping was stopped before pagination setup");
    }

    // Set results per page to 100
    console.log("Setting results per page to 100...");
    await page.waitForSelector(".fds-pagination-selector select");
    await page.click(".fds-pagination-selector select");
    await page.select(".fds-pagination-selector select", "100");

    // Wait for data to reload with 100 records
    await delay(3000);
    await page.waitForSelector("table.fds-data-table tbody tr", {
      visible: true,
      timeout: selectorTimeout,
    });

    // Final pause check before scraping
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      throw new Error("Scraping was stopped before data scraping");
    }

    await dualLogInfo("Starting data scraping...");
    await scrapeData(browser, page, expediaId, startDate, endDate, jobId);
  } catch (error: any) {
    await dualLogError("Error in applyFilter:", error, { jobId });
    // Close browser when done with this attempt
    if (browser) {
      await browser.close();
    }
    await dualLogInfo("Browser closed successfully.");
    throw error;
  }
}
