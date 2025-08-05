import { Browser, Page } from "puppeteer";
import { delay } from "../common/delay.js";
import { progressManager } from "../common/progress-manager.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { scrapeData } from "../scrape-data/scrape-data.js";

export async function retryScrape(
  browser: Browser,
  page: Page,
  propertyId: string,
  reservationId: string,
  jobId?: string
) {
  try {
    // Check if scraping is paused before starting
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      throw new Error("Scraping was stopped during retry scrape");
    }

    // Wait for the page to be fully loaded
    try {
      await page.waitForSelector(".fds-layout", {
        visible: true,
        timeout: 30000,
      });
    } catch (error: any) {
      console.error("Error waiting for page layout:", error);
      
      // Send email notification for page layout error
      if (jobId) {
        try {        } catch (emailError) {
          console.error("Failed to send page layout error notification:", emailError);
        }
      }
      throw error;
    }

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
      const error = new Error("Could not find search input field");
      
      // Send email notification for search input not found
      if (jobId) {
        try {        } catch (emailError) {
          console.error("Failed to send search input missing error notification:", emailError);
        }
      }
      
      throw error;
    }

    // Click the input field first
    try {
      await searchInput.click();
      await delay(1000);
    } catch (error: any) {
      console.error("Error clicking search input:", error);
      
      // Send email notification for search input click error
      if (jobId) {
        try {        } catch (emailError) {
          console.error("Failed to send search input click error notification:", emailError);
        }
      }
      throw error;
    }

    // Clear any existing value
    try {
      await page.evaluate(() => {
        const input =
          document.querySelector('input[name="searchInput"]') ||
          document.querySelector("input.fds-field-input") ||
          document.querySelector('input[type="text"]');
        if (input instanceof HTMLInputElement) input.value = "";
      });
    } catch (error: any) {
      console.error("Error clearing search input:", error);
      
      // Send email notification for search input clear error
      if (jobId) {
        try {        } catch (emailError) {
          console.error("Failed to send search input clear error notification:", emailError);
        }
      }
      throw error;
    }

    // Type the ID into the search input - convert reservationId to string and type it directly
    const idString = String(reservationId);
    try {
      await page.type('input[name="searchInput"]', idString, { delay: 150 });
    } catch (error: any) {
      console.error("Error typing reservation ID:", error);
      
      // Send email notification for reservation ID typing error
      if (jobId) {
        try {        } catch (emailError) {
          console.error("Failed to send reservation ID typing error notification:", emailError);
        }
      }
      throw error;
    }

    // Wait for the save button to be visible and clickable
    try {
      await page.waitForSelector("#save-button", {
        visible: true,
        timeout: 10000,
      });
    } catch (error: any) {
      console.error("Error waiting for save button:", error);
      
      // Send email notification for save button wait error
      if (jobId) {
        try {        } catch (emailError) {
          console.error("Failed to send save button wait error notification:", emailError);
        }
      }
      throw error;
    }

    // Check pause state before scraping
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      throw new Error("Scraping was stopped during retry scrape");
    }

    // Click the save button
    try {
      await page.click("#save-button");
      // Wait for the search to complete
      await delay(2000);
    } catch (error: any) {
      console.error("Error clicking save button:", error);
      
      // Send email notification for save button click error
      if (jobId) {
        try {        } catch (emailError) {
          console.error("Failed to send save button click error notification:", emailError);
        }
      }
      throw error;
    }

    console.log(`Starting retry scrape for reservation: ${reservationId}`);
    try {
      await scrapeData(browser, page, propertyId, undefined, undefined, jobId);
    } catch (error: any) {
      console.error("Error in scrapeData during retry:", error);
      
      // Send email notification for scrapeData error
      if (jobId) {
        try {        } catch (emailError) {
          console.error("Failed to send scrape data error notification:", emailError);
        }
      }
      throw error;
    }
  } catch (error: any) {
    console.error("Error in retryScrape:", error);
    
    // Send email notification for general retry scrape error
    if (jobId) {
      try {      } catch (emailError) {
        console.error("Failed to send general retry scrape error notification:", emailError);
      }
    }
    
    throw error;
  }
}
