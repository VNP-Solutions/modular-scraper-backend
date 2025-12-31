import { Browser, Page } from "puppeteer";
import { delay } from "../common/delay.js";
import { dualLogError, dualLogInfo } from "../common/log-helper.js";
import { scrapingStateManager } from "../common/scraping-state.js";
import { dbDataService } from "../services/db-data.service.js";
import { dbEntryService } from "../services/db-entry.service.js";
import { dbDatachecking } from "./db-data-checking.js";
import { extractInvoiceRows } from "./extract-invoice-rows.js";

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
 * Uses db_billing_duration from job if available, otherwise defaults to 30 days
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

      // Use db_billing_duration if available, otherwise use default logic
      if (dbBillingDuration && dbBillingDuration > 0) {
        // Always use db_billing_duration when provided, regardless of day of month
        const chunkSize = dbBillingDuration;
        const calculatedEnd = addDays(currentStart, chunkSize - 1); // -1 because we include the start date
        chunkEnd = calculatedEnd < endDateObj ? calculatedEnd : endDateObj;
        await dualLogInfo(
          `Using chunk size of ${chunkSize} days (from db_billing_duration: ${dbBillingDuration})`
        );
      } else if (isFirstDayOfMonth(currentStart)) {
        // If starting on 1st day and no db_billing_duration, take whole month
        const lastDayOfMonth = getLastDayOfMonth(currentStart);
        chunkEnd = lastDayOfMonth < endDateObj ? lastDayOfMonth : endDateObj;
        await dualLogInfo(
          `Starting on 1st day of month, taking whole month until ${formatDate(
            chunkEnd
          )} (no db_billing_duration specified)`
        );
      } else {
        // Default to 30 days if no db_billing_duration and not 1st of month
        const chunkSize = 30;
        const calculatedEnd = addDays(currentStart, chunkSize - 1); // -1 because we include the start date
        chunkEnd = calculatedEnd < endDateObj ? calculatedEnd : endDateObj;
        await dualLogInfo(
          `Using default chunk size of ${chunkSize} days (no db_billing_duration specified)`
        );
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
        // Wait for the search form to be ready (especially important in headless mode)
        await dualLogInfo("Waiting for search form to be ready...");
        await page.waitForSelector("#startDateInput", {
          visible: true,
          timeout: 10000,
        });
        await page.waitForSelector("#endDateInput", {
          visible: true,
          timeout: 10000,
        });
        await delay(1000); // Additional wait to ensure form is fully interactive

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

        // Check for date validation error before clicking search
        const hasValidationError = await page.evaluate(() => {
          const validationElement = document.querySelector("#datesValidation");
          if (validationElement) {
            // Check if the validation element is visible (not hidden)
            const style = window.getComputedStyle(validationElement);
            const isVisible =
              style.display !== "none" && style.visibility !== "hidden";

            if (isVisible) {
              // Check if it contains the "last year" error message
              const messageElement =
                validationElement.querySelector(".alert-message");
              if (messageElement) {
                const messageText = messageElement.textContent || "";
                if (
                  messageText.includes(
                    "date range must occur within the last year"
                  )
                ) {
                  return true;
                }
              }
            }
          }

          // Also check if search button is disabled (indicates validation error)
          const searchButton = document.querySelector(
            "#searchButton"
          ) as HTMLButtonElement;
          if (searchButton && searchButton.disabled) {
            return true;
          }

          return false;
        });

        if (hasValidationError) {
          await dualLogInfo(
            `Chunk ${chunkCount}: Date range validation error detected - "The date range must occur within the last year". Skipping this chunk and moving to next date range.`
          );
          // Skip this chunk and move to next
          currentStart = addDays(chunkEnd, 1);
          if (currentStart > endDateObj) {
            await dualLogInfo(
              "Reached end date, date range processing complete"
            );
            break;
          }
          await delay(1000);
          continue; // Continue to next iteration of while loop
        }

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

        // Extract invoice rows BEFORE creating invoice (to ensure table is accessible)
        let invoiceRows: any[] = [];
        if (hasData) {
          try {
            await dualLogInfo(
              `Chunk ${chunkCount}: Extracting invoice rows before invoice creation...`
            );
            invoiceRows = await extractInvoiceRows(page, jobId);
            await dualLogInfo(
              `Chunk ${chunkCount}: Extracted ${invoiceRows.length} invoice row(s) before invoice creation`
            );
          } catch (extractError) {
            await dualLogError(
              `Chunk ${chunkCount}: Error extracting invoice rows before invoice creation:`,
              extractError
            );
            // Continue even if extraction fails
          }
        }

        // Variable to store Gearbox Queue IDs
        let gearboxQueueIds: string[] = [];
        // Variable to store total invoice amount
        let totalInvoiceAmount: number = 0;
        // Variable to store total invoice amount currency
        let totalInvoiceAmountCurrency: string | undefined = undefined;

        if (!hasData) {
          await dualLogInfo(
            `Chunk ${chunkCount}: No data found for this date range, skipping invoice creation and amount extraction`
          );
        } else {
          // Extract total invoice amount and currency only if data exists
          try {
            await dualLogInfo(
              `Chunk ${chunkCount}: Extracting total invoice amount and currency...`
            );

            const extractedData = await page.evaluate(() => {
              const invoiceTotalElement =
                document.querySelector(".invoiceTotal");
              if (invoiceTotalElement) {
                const boldElement = invoiceTotalElement.querySelector("b");
                if (boldElement) {
                  const text = boldElement.textContent || "";

                  // Extract currency code (typically 3 letters like USD, EUR, GBP, etc.)
                  // Look for currency code at the start (e.g., "USD 90.32") or end (e.g., "90.32 USD")
                  const currencyMatchStart = text.match(/^([A-Z]{3})\s/);
                  const currencyMatchEnd = text.match(/\s([A-Z]{3})$/);
                  const currency = currencyMatchStart
                    ? currencyMatchStart[1]
                    : currencyMatchEnd
                    ? currencyMatchEnd[1]
                    : undefined;

                  // Extract number from text like "USD 90.32", "-90.32", "90.32", or "90.32 USD"
                  // Regex now includes optional negative sign and preserves decimal points
                  const amountMatch = text.match(/-?[\d,]+\.?\d*/);
                  let amount = 0;
                  if (amountMatch) {
                    // Remove commas and parse as float (preserves negative sign and decimals)
                    const cleanedAmount = amountMatch[0].replace(/,/g, "");
                    const parsedAmount = parseFloat(cleanedAmount);
                    amount = isNaN(parsedAmount) ? 0 : parsedAmount;
                  }

                  return {
                    amount,
                    currency,
                  };
                }
              }
              return { amount: 0, currency: undefined };
            });

            totalInvoiceAmount = extractedData.amount;
            totalInvoiceAmountCurrency = extractedData.currency;
            await dualLogInfo(
              `Chunk ${chunkCount}: Extracted total invoice amount: ${totalInvoiceAmount} ${
                totalInvoiceAmountCurrency || ""
              }`
            );
          } catch (amountError) {
            await dualLogError(
              `Chunk ${chunkCount}: Error extracting total invoice amount:`,
              amountError
            );
            // Continue with 0 if extraction fails
            totalInvoiceAmount = 0;
            totalInvoiceAmountCurrency = undefined;
          }
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
        let dbDataId: string | null = null;
        try {
          if (jobId && expediaId) {
            await dualLogInfo(
              `Chunk ${chunkCount}: Saving data to database...`
            );

            const dbData = await dbDataService.createDbData({
              job_id: jobId,
              property_name: propertyName || "Unknown Property",
              property_id: expediaId,
              date_range: {
                start_date: fromDateExpedia,
                end_date: toDateExpedia,
              },
              gearbox_queue_ids: gearboxQueueIds,
              total_invoice_amount: totalInvoiceAmount,
              total_invoice_amount_currency: totalInvoiceAmountCurrency,
            });

            dbDataId = dbData._id.toString();

            if (gearboxQueueIds.length > 0) {
              await dualLogInfo(
                `Chunk ${chunkCount}: Data saved successfully to database with ${gearboxQueueIds.length} Gearbox Queue ID(s). DB Data ID: ${dbDataId}`
              );
            } else {
              await dualLogInfo(
                `Chunk ${chunkCount}: Data saved successfully to database with no Gearbox Queue IDs (no data found for this date range). DB Data ID: ${dbDataId}`
              );
            }

            // Save invoice rows to db_entry if we have data and db_data_id
            if (hasData && dbDataId && invoiceRows.length > 0) {
              try {
                await dualLogInfo(
                  `Chunk ${chunkCount}: Saving ${invoiceRows.length} invoice row(s) to db_entry...`
                );

                // Prepare db_entry records
                const dbEntries = invoiceRows.map((row) => ({
                  job_id: jobId,
                  property_name: propertyName || "Unknown Property",
                  property_id: expediaId,
                  db_data_id: dbDataId!,
                  reservation_id: row.reservation_id,
                  invoice_id: row.invoice_id,
                  guest_name: row.guest_name,
                  check_in_date: row.check_in_date,
                  check_out_date: row.check_out_date,
                  previously_paid_amount: row.previously_paid_amount,
                  previously_paid_amount_currency:
                    row.previously_paid_amount_currency,
                  maximum_billable_amount: row.maximum_billable_amount,
                  maximum_billable_amount_currency:
                    row.maximum_billable_amount_currency,
                  requested_booking_amount: row.requested_booking_amount,
                  requested_taxes: row.requested_taxes,
                  requested_total: row.requested_total,
                  requested_total_currency: row.requested_total_currency,
                }));

                // Save all entries in bulk
                await dbEntryService.createDbEntries(dbEntries);

                await dualLogInfo(
                  `Chunk ${chunkCount}: Successfully saved ${invoiceRows.length} row(s) to db_entry collection`
                );
              } catch (entryError) {
                await dualLogError(
                  `Chunk ${chunkCount}: Error saving invoice rows to db_entry:`,
                  entryError
                );
                // Don't throw error, continue with next chunk
              }
            } else {
              if (!hasData) {
                await dualLogInfo(
                  `Chunk ${chunkCount}: No data found, skipping db_entry save`
                );
              } else if (!dbDataId) {
                await dualLogInfo(
                  `Chunk ${chunkCount}: No db_data_id available, skipping db_entry save`
                );
              } else if (invoiceRows.length === 0) {
                await dualLogInfo(
                  `Chunk ${chunkCount}: No invoice rows extracted, skipping db_entry save`
                );
              }
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
