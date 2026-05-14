import { Browser, Page } from "puppeteer";
import { delay } from "../common/delay.js";
import {
  FAILED_REASON,
  setFailedReasonCode,
} from "../common/failed-reason.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { timeoutManager } from "../common/timeout-manager.js";

/**
 * Expedia Partner Central serves two different UIs as the post-login property
 * search page, depending on the account / time of day. Both are handled:
 *
 *  - "modern"  → All-properties SPA dashboard. Container `.fds-data-table-wrapper`
 *                with search input `.all-properties__search input.fds-field-input`
 *                and result rows in `tbody tr` (.property-cell__property-id /
 *                .property-cell__property-name).
 *  - "legacy"  → Old "Manage a property" page. Container `.manage-property` with
 *                search input `#search_box` and result list
 *                `.search-result-list .results-list li` (.hotel-id /
 *                a.landing-page). The legacy result link points at
 *                apps.expediapartnercentral.com/supply/home?htid=…, which is the
 *                same modern property page reached via the modern flow, so the
 *                drawer / Reservations|Payments click step works for both.
 */
type PropertySearchUiKind = "modern" | "legacy";

async function waitForPropertySearchPage(
  page: Page,
  timeoutMs: number
): Promise<PropertySearchUiKind> {
  const modern = page
    .waitForSelector(".fds-data-table-wrapper", {
      visible: true,
      timeout: timeoutMs,
    })
    .then(() => "modern" as const);

  const legacy = page
    .waitForSelector(".manage-property #search_box", {
      visible: true,
      timeout: timeoutMs,
    })
    .then(() => "legacy" as const);

  // First UI to render wins. If neither shows up in time, both reject and
  // Promise.race rejects with the first rejection (Puppeteer TimeoutError),
  // which is the same behaviour callers had before for "page never loaded".
  return Promise.race([modern, legacy]);
}

/**
 * Detects the property search UI, types the property ID into the right input,
 * finds the matching result row/list item and clicks through to the property
 * page. Works for both UIs:
 *
 *  - modern: types into `.all-properties__search input.fds-field-input`,
 *    finds a `<tr>` whose `.property-cell__property-id span` contains the ID,
 *    clicks `.property-cell__property-name a`.
 *  - legacy: types into `#search_box`, waits for
 *    `.search-result-list .results-list li a.landing-page`, finds the `<li>`
 *    whose `.hotel-id` text contains the ID, clicks its `a.landing-page`.
 *    The legacy result link points at apps.expediapartnercentral.com/supply/home?htid=…,
 *    which is the same modern property page reached via the modern flow, so
 *    the caller's subsequent drawer / Reservations|Payments click works as-is.
 *
 * Throws with FAILED_REASON.PROPERTY_NOT_FOUND if the ID isn't on the page.
 */
async function searchAndClickPropertyById(
  page: Page,
  propertyId: string,
  selectorTimeout: number,
  loadingTimeout: number
): Promise<void> {
  const detectedUi = await waitForPropertySearchPage(page, selectorTimeout);
  await dualLogInfo(
    `Property search page detected. UI variant: ${detectedUi}`
  );

  await scrapingStateManager.waitWhilePaused();
  if (!scrapingStateManager.isRunning()) {
    await dualLogError("Scraping was stopped during property search");
    throw new Error("Scraping was stopped during property search");
  }

  if (detectedUi === "modern") {
    await page.waitForSelector(
      ".all-properties__search input.fds-field-input"
    );

    await dualLogInfo(`Searching for property ID: ${propertyId}`);

    await delay(20000);
    await page.type(
      ".all-properties__search input.fds-field-input",
      String(propertyId),
      { delay: 500 }
    );

    await delay(2000);

    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogError("Scraping was stopped during property search");
      throw new Error("Scraping was stopped during property search");
    }

    try {
      await page.waitForSelector("tbody tr", {
        visible: true,
        timeout: loadingTimeout,
      });

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

      if (!clicked) {
        const err = new Error(`Could not find property with ID: ${propertyId}`);
        setFailedReasonCode(err, FAILED_REASON.PROPERTY_NOT_FOUND);
        throw err;
      }

      await dualLogInfo(`Found and clicked property with ID: ${propertyId}`);

      await Promise.all([
        page.waitForNavigation({
          waitUntil: "networkidle0",
          timeout: loadingTimeout,
        }),
        delay(8000),
      ]);

      await dualLogInfo("Successfully navigated to property page");
    } catch (error: any) {
      await dualLogError(`Error finding/clicking property: ${error.message}`);
      throw error;
    }
    return;
  }

  // detectedUi === "legacy" — the old "Manage a property" page
  await dualLogInfo(`Searching for property ID (legacy UI): ${propertyId}`);

  // Focus the legacy search box, clear any pre-existing value, then type the ID
  await page.click("#search_box").catch(() => undefined);
  await delay(500);
  await page.evaluate(() => {
    const el = document.querySelector<HTMLInputElement>("#search_box");
    if (el) {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await page.type("#search_box", String(propertyId), { delay: 300 });

  // Legacy results are XHR-rendered after typing; give them a moment
  await delay(5000);

  await scrapingStateManager.waitWhilePaused();
  if (!scrapingStateManager.isRunning()) {
    await dualLogError("Scraping was stopped during property search");
    throw new Error("Scraping was stopped during property search");
  }

  try {
    await page.waitForSelector(
      ".search-result-list .results-list li a.landing-page",
      {
        visible: true,
        timeout: loadingTimeout,
      }
    );

    const clicked = await page.evaluate((searchId) => {
      const items = Array.from(
        document.querySelectorAll(".search-result-list .results-list li")
      );
      for (const li of items) {
        const idEl = li.querySelector(".hotel-id");
        if (idEl && idEl.textContent && idEl.textContent.includes(searchId)) {
          const link = li.querySelector("a.landing-page");
          if (link && link instanceof HTMLElement) {
            link.click();
            return true;
          }
        }
      }
      return false;
    }, String(propertyId));

    if (!clicked) {
      const err = new Error(
        `Could not find property with ID: ${propertyId} in legacy "Manage a property" results`
      );
      setFailedReasonCode(err, FAILED_REASON.PROPERTY_NOT_FOUND);
      throw err;
    }

    await dualLogInfo(
      `Found and clicked property with ID ${propertyId} (legacy UI)`
    );

    await Promise.all([
      page.waitForNavigation({
        waitUntil: "networkidle0",
        timeout: loadingTimeout,
      }),
      delay(8000),
    ]);

    await dualLogInfo(
      "Successfully navigated to property page (from legacy UI)"
    );
  } catch (error: any) {
    await dualLogError(
      `Error finding/clicking property in legacy UI: ${error.message}`
    );
    throw error;
  }
}

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
      await searchAndClickPropertyById(
        page,
        propertyId,
        selectorTimeout,
        loadingTimeout
      );
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
        throw new Error("Could not find or click Reservations link");
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
    } catch (error) {
      await dualLogError(`Error searching for property ${propertyId}:`, error);
      // Close browser when done with this attempt
      if (browser) {
        await browser.close();
      }
      await dualLogInfo("Browser closed successfully.");
      throw error;
    }
  } catch (error: any) {
    await dualLogError(`Error searching for property ${propertyId}:`, error);
    throw error;
  }
}

export async function propertySearchAndClickPayments(
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
      await searchAndClickPropertyById(
        page,
        propertyId,
        selectorTimeout,
        loadingTimeout
      );
    }

    // Check pause state before finding payments
    await scrapingStateManager.waitWhilePaused();
    if (!scrapingStateManager.isRunning()) {
      await dualLogError("Scraping was stopped during property search");
      throw new Error("Scraping was stopped during property search");
    }

    // Find and click the Payments link
    await dualLogInfo("Looking for Payments link...");

    try {
      // Wait for the drawer content to load
      await page.waitForSelector(".uitk-drawer-content", {
        visible: true,
        timeout: loadingTimeout,
      });

      // Click using JavaScript with the exact structure
      const clicked = await page.evaluate(() => {
        const paymentsItem = Array.from(
          document.querySelectorAll(".uitk-action-list-item-content")
        ).find((item) => {
          const textDiv = item.querySelector(".uitk-text.overflow-wrap");
          return textDiv && textDiv.textContent?.trim() === "Payments";
        });

        if (paymentsItem) {
          const link = paymentsItem.querySelector(
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
        throw new Error("Could not find or click Payments link");
      }

      // Wait for navigation to complete
      await Promise.all([
        page.waitForNavigation({
          waitUntil: "networkidle0",
          timeout: loadingTimeout,
        }),
        delay(8000),
      ]);

      await dualLogInfo("Successfully navigated to Payments page");
    } catch (error) {
      await dualLogError(`Error searching for property ${propertyId}:`, error);
      // Close browser when done with this attempt
      if (browser) {
        await browser.close();
      }
      await dualLogInfo("Browser closed successfully.");
      throw error;
    }
  } catch (error: any) {
    await dualLogError(`Error searching for property ${propertyId}:`, error);
    throw error;
  }
}
