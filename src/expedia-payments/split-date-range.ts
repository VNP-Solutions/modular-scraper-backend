import { Browser, Page } from "puppeteer";
import { delay } from "../common/delay.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { dbDataService } from "../services/db-data.service.js";
import { dbDatachecking } from "./db-data-checking.js";

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
 * Split date range into chunks and process each chunk
 * Expedia allows up to 31 days per search
 */
export async function splitDateRange(
  browser: Browser,
  page: Page,
  startDate: string,
  endDate: string,
  jobId?: string,
  expediaId?: string,
  propertyName?: string
): Promise<void> {
  try {
    await dualLogInfo(`Starting date range split: ${startDate} to ${endDate}`);

    const startDateObj = parseDate(startDate);
    const endDateObj = parseDate(endDate);
    let currentStart = startDateObj;

    let chunkCount = 0;

    while (currentStart <= endDateObj) {
      chunkCount++;

      // Check if scraping is paused
      await scrapingStateManager.waitWhilePaused();
      if (!scrapingStateManager.isRunning()) {
        await dualLogError("Scraping was stopped during date range processing");
        throw new Error("Scraping was stopped during date range processing");
      }

      // Calculate chunk end date
      let chunkEnd: Date;

      if (isFirstDayOfMonth(currentStart)) {
        // If starting on 1st day, take whole month
        const lastDayOfMonth = getLastDayOfMonth(currentStart);
        chunkEnd = lastDayOfMonth < endDateObj ? lastDayOfMonth : endDateObj;
        await dualLogInfo(
          `Starting on 1st day of month, taking whole month until ${formatDate(
            chunkEnd
          )}`
        );
      } else {
        // Otherwise, take 30 days
        const calculatedEnd = addDays(currentStart, 30);
        chunkEnd = calculatedEnd < endDateObj ? calculatedEnd : endDateObj;
      }

      const chunkStartStr = formatDate(currentStart);
      const chunkEndStr = formatDate(chunkEnd);

      await dualLogInfo(
        `Processing chunk ${chunkCount}: ${chunkStartStr} to ${chunkEndStr}`
      );

      // Convert to DD/MM/YYYY format for Expedia form
      const fromDateExpedia = convertDateFormat(chunkStartStr);
      const toDateExpedia = convertDateFormat(chunkEndStr);

      await dualLogInfo(
        `Expedia format: From ${fromDateExpedia} To ${toDateExpedia}`
      );

      // Type dates into the input fields
      try {
        // Clear and type "From" date
        await page.click("#startDateInput", { clickCount: 3 });
        await delay(500);
        await page.type("#startDateInput", fromDateExpedia, { delay: 100 });
        await dualLogInfo(`Typed From date: ${fromDateExpedia}`);

        await delay(1000);

        // Clear and type "To" date
        await page.click("#endDateInput", { clickCount: 3 });
        await delay(500);
        await page.type("#endDateInput", toDateExpedia, { delay: 100 });
        await dualLogInfo(`Typed To date: ${toDateExpedia}`);

        await delay(1000);

        // Click the Search button
        await dualLogInfo("Clicking Search button...");
        await page.click("#searchButton");

        await dualLogInfo("Search button clicked, waiting for results...");

        // Wait for any loading indicator to appear and disappear
        await delay(2000);

        try {
          await dualLogInfo("Waiting for loading to complete...");
          // Wait for loading indicator if it exists
          await page
            .waitForSelector(".fds-loader.is-loading.is-visible", {
              visible: true,
              timeout: 5000,
            })
            .catch(() => dualLogInfo("No loading indicator found"));

          // Wait for loading to disappear
          await page
            .waitForSelector(".fds-loader.is-loading.is-visible", {
              hidden: true,
              timeout: 30000,
            })
            .catch(() => dualLogInfo("Loading indicator already hidden"));

          await dualLogInfo("Loading completed");
        } catch (loadError) {
          await dualLogInfo("Loading detection skipped:", loadError);
        }

        await delay(3000); // Additional wait for table to be fully rendered

        // Check and validate invoice data for this chunk
        await dualLogInfo(
          `Checking and validating data for chunk ${chunkCount}...`
        );
        const hasData = await dbDatachecking(browser, page, jobId);
        await dualLogInfo(`Chunk ${chunkCount} data validation completed`);

        // Variable to store Gearbox Queue IDs
        let gearboxQueueIds: string[] = [];

        if (!hasData) {
          await dualLogInfo(
            `Chunk ${chunkCount}: No data found for this date range, skipping invoice creation`
          );
        } else {
          // Check disclaimer checkbox and submit invoice
          await dualLogInfo(
            `Chunk ${chunkCount}: Checking disclaimer checkbox...`
          );

          await page.evaluate(() => {
            const disclaimerCheckbox = document.querySelector(
              "#invoiceUploadDisclaimer"
            ) as HTMLInputElement;
            if (disclaimerCheckbox && !disclaimerCheckbox.checked) {
              disclaimerCheckbox.click();
            }
          });

          await delay(500);
          await dualLogInfo(`Chunk ${chunkCount}: Disclaimer checkbox checked`);

          // Click "Create Invoice" button
          await dualLogInfo(
            `Chunk ${chunkCount}: Clicking 'Create Invoice' button...`
          );

          //TODO: create invoice button here
          await page.click("#submitInvoice");
          await delay(3000); // Wait for invoice creation

          // Wait for success alert and get Gearbox Queue ID(s)
          try {
            await page.waitForSelector("#success-alert", { timeout: 10000 });

            const extractedIds = await page.evaluate(() => {
              const successAlert = document.querySelector("#success-alert");
              if (successAlert) {
                // Find all <p> tags that contain "Gearbox Queue ID"
                const paragraphs = Array.from(
                  successAlert.querySelectorAll("p")
                );
                const ids: string[] = [];

                paragraphs.forEach((p) => {
                  const text = p.textContent || "";
                  if (text.includes("Gearbox Queue ID")) {
                    // Extract all <b> tags within this paragraph
                    const boldElements = p.querySelectorAll("b");
                    boldElements.forEach((b) => {
                      const id = b.textContent?.trim();
                      if (id) {
                        ids.push(id);
                      }
                    });
                  }
                });

                return ids.length > 0 ? ids : [];
              }
              return [];
            });

            gearboxQueueIds = extractedIds;

            if (gearboxQueueIds.length > 0) {
              if (gearboxQueueIds.length === 1) {
                await dualLogInfo(
                  `Chunk ${chunkCount}: Invoice created successfully! Gearbox Queue ID: ${gearboxQueueIds[0]}`
                );
              } else {
                await dualLogInfo(
                  `Chunk ${chunkCount}: Invoice created successfully! Gearbox Queue IDs: ${gearboxQueueIds.join(
                    ", "
                  )}`
                );
              }
            } else {
              await dualLogInfo(
                `Chunk ${chunkCount}: Invoice created successfully!`
              );
            }
          } catch (waitError) {
            await dualLogError(
              `Chunk ${chunkCount}: Could not find success alert:`,
              waitError
            );
            await dualLogInfo(
              `Chunk ${chunkCount}: Invoice creation status unknown`
            );
          }
        }

        // Save to database (always save, even with no queue IDs)
        try {
          if (jobId && expediaId) {
            await dualLogInfo(
              `Chunk ${chunkCount}: Saving data to database...`
            );

            await dbDataService.createDbData({
              job_id: jobId,
              property_name: propertyName || "Unknown Property",
              property_id: expediaId,
              date_range: {
                start_date: fromDateExpedia,
                end_date: toDateExpedia,
              },
              gearbox_queue_ids: gearboxQueueIds,
            });

            if (gearboxQueueIds.length > 0) {
              await dualLogInfo(
                `Chunk ${chunkCount}: Data saved successfully to database with ${gearboxQueueIds.length} Gearbox Queue ID(s)`
              );
            } else {
              await dualLogInfo(
                `Chunk ${chunkCount}: Data saved successfully to database with no Gearbox Queue IDs (no data found for this date range)`
              );
            }
          } else {
            await dualLogInfo(
              `Chunk ${chunkCount}: Skipping database save - missing required data (jobId: ${!!jobId}, expediaId: ${!!expediaId})`
            );
          }
        } catch (dbError) {
          await dualLogError(
            `Chunk ${chunkCount}: Error saving to database:`,
            dbError
          );
          // Don't throw error, continue with next chunk
        }
        await dualLogInfo(`Chunk ${chunkCount} processed successfully`);

        // After processing this chunk, navigate back to search form for next chunk
        if (currentStart < endDateObj) {
          await dualLogInfo("Navigating back to search form for next chunk...");

          try {
            if (hasData) {
              // If data was found and invoice was created, click "Add more reservation IDs"
              const showSearchClicked = await page.evaluate(() => {
                const showSearchLink = document.querySelector("a.showSearch");
                if (showSearchLink && showSearchLink instanceof HTMLElement) {
                  showSearchLink.click();
                  return true;
                }
                return false;
              });

              if (showSearchClicked) {
                await dualLogInfo(
                  "Clicked 'Add more reservation IDs' successfully"
                );
                await delay(2000);
              } else {
                await dualLogInfo(
                  "Could not find 'Add more reservation IDs' link, search form may already be visible"
                );
              }
            } else {
              // If no data was found, search form should already be visible
              await dualLogInfo(
                "No data was found in previous chunk, search form should already be visible"
              );
              await delay(1000);
            }
          } catch (navError) {
            await dualLogError(
              "Error navigating back to search form:",
              navError
            );
            // Continue anyway, maybe the form is already visible
          }
        }
      } catch (error) {
        await dualLogError(`Error processing chunk ${chunkCount}:`, error);
        throw error;
      }

      // Move to next chunk (day after current chunk end)
      currentStart = addDays(chunkEnd, 1);

      // If we've reached or passed the end date, break
      if (currentStart > endDateObj) {
        await dualLogInfo("Reached end date, date range processing complete");
        break;
      }

      await delay(2000);
    }

    await dualLogInfo(
      `Date range split completed. Processed ${chunkCount} chunk(s)`
    );
  } catch (error: any) {
    await dualLogError("Error in splitDateRange:", error);
    throw error;
  }
}
