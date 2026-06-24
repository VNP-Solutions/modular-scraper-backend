import { Browser, Page } from "puppeteer";
import { delay } from "../common/delay.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { takeScreenshot } from "../common/screenshot-helper.js";

/**
 * Convert date from MM/DD/YYYY to DD/MM/YYYY format
 */
function convertDateFormat(dateStr: string): string {
  const [month, day, year] = dateStr.split("/");
  return `${day}/${month}/${year}`;
}

/**
 * Parse date string MM/DD/YYYY to Date object
 */
function parseDate(dateStr: string): Date {
  const [month, day, year] = dateStr.split("/").map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Format Date object to MM/DD/YYYY string
 */
function formatDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const year = date.getFullYear();
  return `${month}/${day}/${year}`;
}

/**
 * Add days to a date
 */
function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Get the last day of the month for a given date
 */
function getLastDayOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

/**
 * Check if date is the first day of the month
 */
function isFirstDayOfMonth(date: Date): boolean {
  return date.getDate() === 1;
}

/**
 * Extract reservation IDs from the current search results table.
 * Returns an empty array if no table / no rows found.
 */
async function extractReservationIdsFromTable(
  page: Page,
  chunkNumber: number
): Promise<string[]> {
  // Check for "No results found" alert
  const noResultsVisible = await page.evaluate(() => {
    const alert = document.querySelector(
      "#noResultsAlert"
    ) as HTMLElement | null;
    if (!alert) return false;
    return alert.offsetParent !== null;
  });

  if (noResultsVisible) {
    await dualLogInfo(
      `Chunk ${chunkNumber}: "No results found" alert visible — 0 reservation IDs`
    );
    return [];
  }

  // Check if table-contents div exists
  const tableContentsExists = await page.evaluate(() => {
    return document.querySelector("#table-contents") !== null;
  });

  if (!tableContentsExists) {
    await dualLogInfo(
      `Chunk ${chunkNumber}: Table contents div not found — 0 reservation IDs`
    );
    return [];
  }

  // Check if invoice table exists
  const tableExists = await page
    .waitForSelector("#invoice-details-table", {
      visible: true,
      timeout: 15000,
    })
    .then(() => true)
    .catch(async () => {
      return await page.evaluate(
        () => document.querySelector("#invoice-details-table") !== null
      );
    });

  if (!tableExists) {
    await dualLogInfo(
      `Chunk ${chunkNumber}: Invoice table not found — 0 reservation IDs`
    );
    return [];
  }

  await delay(2000); // Let table fully render

  // Extract reservation IDs from each row
  const ids = await page.evaluate(() => {
    const rows = document.querySelectorAll("#invoice-details-table tbody tr");
    const result: string[] = [];

    rows.forEach((row) => {
      const td =
        row.querySelector('td[data-title="Reservation ID"]') ||
        row.querySelector('td[data-title="Reservation"]') ||
        row.querySelector("td.reservationId");

      const rawId = td?.textContent?.trim() || "";
      if (rawId) {
        result.push(rawId);
      }
    });

    return result;
  });

  return ids;
}

/**
 * Split date range into monthly chunks. For each chunk:
 *   1. Type the date range into the form and click Search
 *   2. Collect all reservation IDs from the results table
 *   3. Add them to the in-memory array
 *
 * Returns the full array of collected reservation IDs once all chunks finish.
 */
export async function splitDateRange(
  browser: Browser,
  page: Page,
  startDate: string,
  endDate: string,
  jobId?: string,
  expediaId?: string,
  propertyName?: string,
  dbBillingDuration?: number
): Promise<string[]> {
  // In-memory store for ALL reservation IDs collected across all chunks
  const allReservationIds: string[] = []
  ;

  try {
    await dualLogInfo(`Starting date range split: ${startDate} to ${endDate}`);

    const startDateObj = parseDate(startDate);
    const endDateObj = parseDate(endDate);
    let currentStart = startDateObj;

    let chunkCount = 0;

    while (currentStart <= endDateObj) {
      chunkCount++;

      // Check pause / stop state
      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        await dualLogError(
          "Scraping was stopped during date range processing"
        );
        throw new Error("Scraping was stopped during date range processing");
      }

      // Calculate chunk end — always align to month boundaries
      let chunkEnd: Date;

      if (isFirstDayOfMonth(currentStart)) {
        const lastDayOfMonth = getLastDayOfMonth(currentStart);
        chunkEnd =
          lastDayOfMonth < endDateObj ? lastDayOfMonth : endDateObj;
        await dualLogInfo(
          `Chunk ${chunkCount}: Starting on 1st of month → full month until ${formatDate(chunkEnd)}`
        );
      } else {
        const lastDayOfMonth = getLastDayOfMonth(currentStart);
        chunkEnd =
          lastDayOfMonth < endDateObj ? lastDayOfMonth : endDateObj;
        await dualLogInfo(
          `Chunk ${chunkCount}: Starting mid-month → rest of month until ${formatDate(chunkEnd)}`
        );
      }

      const chunkStartStr = formatDate(currentStart);
      const chunkEndStr = formatDate(chunkEnd);

      await dualLogInfo(
        `Processing chunk ${chunkCount}: ${chunkStartStr} to ${chunkEndStr}`
      );

      // Convert to DD/MM/YYYY for Expedia form
      const fromDateExpedia = convertDateFormat(chunkStartStr);
      const toDateExpedia = convertDateFormat(chunkEndStr);

      await dualLogInfo(
        `Expedia format: From ${fromDateExpedia}  To ${toDateExpedia}`
      );

      try {
        // Wait for search form fields
        await dualLogInfo(
          `Chunk ${chunkCount}: Waiting for search form...`
        );
        await page.waitForSelector("#startDateInput", {
          visible: true,
          timeout: 10000,
        });
        await page.waitForSelector("#endDateInput", {
          visible: true,
          timeout: 10000,
        });
        await delay(1000);

        // Fill From date
        await page.click("#startDateInput", { clickCount: 3 });
        await delay(500);
        await page.type("#startDateInput", fromDateExpedia, { delay: 100 });
        await dualLogInfo(`Chunk ${chunkCount}: Typed From date: ${fromDateExpedia}`);
        await delay(1000);

        // Fill To date
        await page.click("#endDateInput", { clickCount: 3 });
        await delay(500);
        await page.type("#endDateInput", toDateExpedia, { delay: 100 });
        await dualLogInfo(`Chunk ${chunkCount}: Typed To date: ${toDateExpedia}`);
        await delay(1000);

        // Check for date validation error
        const hasValidationError = await page.evaluate(() => {
          const validationElement = document.querySelector("#datesValidation");
          if (validationElement) {
            const style = window.getComputedStyle(validationElement);
            const isVisible =
              style.display !== "none" && style.visibility !== "hidden";
            if (isVisible) {
              const msg = validationElement.querySelector(".alert-message");
              if (
                msg?.textContent?.includes(
                  "date range must occur within the last year"
                )
              ) {
                return true;
              }
            }
          }
          const searchBtn = document.querySelector(
            "#searchButton"
          ) as HTMLButtonElement;
          return !!(searchBtn && searchBtn.disabled);
        });

        if (hasValidationError) {
          await dualLogInfo(
            `Chunk ${chunkCount}: Validation error "date range must occur within the last year" — skipping chunk`
          );

          if (jobId) {
            const validationStep = `date_range_chunk_${chunkCount}_${chunkStartStr.replace(
              /\//g,
              "-"
            )}_to_${chunkEndStr.replace(/\//g, "-")}_validation_error`;
            await takeScreenshot(
              page,
              jobId,
              validationStep,
              "step",
              "expedia"
            ).catch(() => undefined);
          }

          currentStart = addDays(chunkEnd, 1);
          if (currentStart > endDateObj) {
            await dualLogInfo(
              "Reached end date, date range processing complete"
            );
            break;
          }
          await delay(1000);
          continue;
        }

        // Click Search
        await dualLogInfo(`Chunk ${chunkCount}: Clicking Search button...`);
        await page.click("#searchButton");
        await dualLogInfo(
          `Chunk ${chunkCount}: Search clicked, waiting for results...`
        );
        await delay(2000);

        // Wait for loading indicator
        try {
          await page
            .waitForSelector(".fds-loader.is-loading.is-visible", {
              visible: true,
              timeout: 5000,
            })
            .catch(() =>
              dualLogInfo(`Chunk ${chunkCount}: No loading indicator found`)
            );

          await page
            .waitForSelector(".fds-loader.is-loading.is-visible", {
              hidden: true,
              timeout: 30000,
            })
            .catch(() =>
              dualLogInfo(
                `Chunk ${chunkCount}: Loading indicator already hidden`
              )
            );

          await dualLogInfo(`Chunk ${chunkCount}: Loading completed`);
        } catch (loadErr) {
          await dualLogInfo(
            `Chunk ${chunkCount}: Loading detection skipped`,
            loadErr
          );
        }

        await delay(3000);

        // ── PHASE 1 ONLY: Collect reservation IDs into memory ──
        await dualLogInfo(
          `Chunk ${chunkCount}: Extracting reservation IDs from results...`
        );
        const chunkIds = await extractReservationIdsFromTable(page, chunkCount);

        if (chunkIds.length > 0) {
          await dualLogInfo(
            `Chunk ${chunkCount}: Found ${chunkIds.length} reservation ID(s): ${chunkIds.join(", ")}`
          );
          allReservationIds.push(...chunkIds);
        } else {
          await dualLogInfo(
            `Chunk ${chunkCount}: No reservation IDs found in this date range`
          );
        }

        await dualLogInfo(
          `Chunk ${chunkCount}: In-memory total so far: ${allReservationIds.length} reservation ID(s)`
        );

        // Per-chunk results screenshot. Naming: date_range_chunk_<n>_<from>_to_<to>
        // (slashes in dates → dashes so they're filename-safe).
        if (jobId) {
          const chunkScreenshotStep = `date_range_chunk_${chunkCount}_${chunkStartStr.replace(
            /\//g,
            "-"
          )}_to_${chunkEndStr.replace(/\//g, "-")}`;
          await takeScreenshot(
            page,
            jobId,
            chunkScreenshotStep,
            "step",
            "expedia"
          ).catch(() => undefined);
        }

        // Navigate back to search form for the next chunk
        if (currentStart < endDateObj) {
          await dualLogInfo(
            `Chunk ${chunkCount}: Navigating back to date range search form...`
          );
          try {
            // Try clicking "Add more reservation IDs" link if present
            const showSearchClicked = await page.evaluate(() => {
              const link = document.querySelector(
                "a.showSearch"
              ) as HTMLElement | null;
              if (link) {
                link.click();
                return true;
              }
              return false;
            });

            if (showSearchClicked) {
              await dualLogInfo(
                `Chunk ${chunkCount}: Clicked 'Add more reservation IDs' link`
              );
              await delay(2000);
            } else {
              await dualLogInfo(
                `Chunk ${chunkCount}: 'Add more reservation IDs' not found — search form may already be visible`
              );
              await delay(1000);
            }

            // Make sure we're on the By Date Range tab for the next chunk
            const dateTabClicked = await page.evaluate(() => {
              const btn = document.querySelector(
                "#tab-dateRangeSearch"
              ) as HTMLElement | null;
              if (btn) {
                btn.click();
                return true;
              }
              return false;
            });

            if (dateTabClicked) {
              await delay(1500);
              await dualLogInfo(
                `Chunk ${chunkCount}: Re-selected 'By Date Range' tab for next chunk`
              );
            }
          } catch (navErr) {
            await dualLogError(
              `Chunk ${chunkCount}: Error navigating back to search form:`,
              navErr
            );
            // Continue anyway
          }
        }
      } catch (chunkErr) {
        await dualLogError(
          `Chunk ${chunkCount}: Error processing chunk:`,
          chunkErr
        );
        if (jobId) {
          const chunkErrorStep = `date_range_chunk_${chunkCount}_${chunkStartStr.replace(
            /\//g,
            "-"
          )}_to_${chunkEndStr.replace(/\//g, "-")}_error`;
          await takeScreenshot(
            page,
            jobId,
            chunkErrorStep,
            "error",
            "expedia"
          ).catch(() => undefined);
        }
        throw chunkErr;
      }

      // Advance to next chunk
      currentStart = addDays(chunkEnd, 1);

      if (currentStart > endDateObj) {
        await dualLogInfo("Reached end date, date range processing complete");
        break;
      }

      await delay(2000);
    }

    await dualLogInfo(
      `Date range split completed. Processed ${chunkCount} chunk(s). ` +
      `Total reservation IDs collected in memory: ${allReservationIds.length}`
    );

    // Phase 1 ends on the results view — reveal the search form for Phase 2
    await dualLogInfo(
      "Phase 1 complete: navigating back to search form before reservation ID processing..."
    );
    try {
      const showSearchClicked = await page.evaluate(() => {
        const link = document.querySelector("a.showSearch") as HTMLElement | null;
        if (link) {
          link.click();
          return true;
        }
        return false;
      });

      if (showSearchClicked) {
        await dualLogInfo("Clicked 'Add more reservation IDs' after final chunk");
        await delay(2000);
      } else {
        await dualLogInfo(
          "'Add more reservation IDs' not found — search form may already be visible"
        );
      }
    } catch (navErr) {
      await dualLogError(
        "Error navigating back to search form after Phase 1:",
        navErr
      );
    }

    if (allReservationIds.length > 0) {
      await dualLogInfo(
        `All collected reservation IDs: ${allReservationIds.join(", ")}`
      );
    }

    return allReservationIds;
  } catch (error: any) {
    await dualLogError("Error in splitDateRange:", error);
    throw error;
  }
}
