import { Page } from "puppeteer";
import { delay } from "../common/delay.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { scrapeData } from "../scrape-data/scrape-data.js";


export async function retryScrape(
  page: Page,
  propertyId: string,
  reservationId: string
) {
  try {
    // Check if scraping is paused before starting
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      throw new Error("Scraping was stopped during retry scrape");
    }

    // Wait for the page to be fully loaded
    await page.waitForSelector(".fds-layout", {
      visible: true,
      timeout: 30000,
    });

    // Check pause state before searching
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      throw new Error("Scraping was stopped during retry scrape");
    }

    // Try to find the search input using multiple possible selectors
    const searchInputSelectors = [
      'input[name="searchInput"]',
      "input.fds-field-input",
      'input[type="text"]',
      ".fds-field-input",
    ];

    let searchInput = null;
    for (const selector of searchInputSelectors) {
      try {
        searchInput = await page.waitForSelector(selector, {
          visible: true,
          timeout: 5000,
        });
        if (searchInput) break;
      } catch (e) {
        continue;
      }
    }

    if (!searchInput) {
      throw new Error("Could not find search input field");
    }

    // Click the input field first
    await searchInput.click();
    await delay(1000);

    // Clear any existing value
    await page.evaluate(() => {
      const input =
        document.querySelector('input[name="searchInput"]') ||
        document.querySelector("input.fds-field-input") ||
        document.querySelector('input[type="text"]');
      if (input instanceof HTMLInputElement) input.value = "";
    });

    // Type the ID into the search input - convert reservationId to string and type it directly
    const idString = String(reservationId);
    await page.type('input[name="searchInput"]', idString, { delay: 150 });

    // Wait for the save button to be visible and clickable
    await page.waitForSelector("#save-button", {
      visible: true,
      timeout: 10000,
    });

    // Check pause state before scraping
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      throw new Error("Scraping was stopped during retry scrape");
    }

    // Click the save button
    await page.click("#save-button");
    // Wait for the search to complete
    await delay(2000);

    console.log(`Starting retry scrape for reservation: ${reservationId}`);
    await scrapeData(page, propertyId);
  } catch (error: any) {
    console.error("Error in retryScrape:", error);
    throw error;
  }
}
